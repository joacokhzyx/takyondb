/**
 * Schema compilation: turns a field-type map into the byte offsets that
 * `client/proxy.ts` addresses the shared arena with.
 */

/** The four storable field types and their physical widths. */
export type FieldType = 'uint8' | 'uint32' | 'float64' | 'string';

/** One compiled field: where it starts in the record and how wide it is. */
export interface FieldDefinition {
    /** The declared type. */
    type: FieldType;
    /** Byte offset of the field from the start of the record. */
    offset: number;
    /** Field width in bytes. `string` is 8: a u32 offset plus a u32 length. */
    size: number;
}

/**
 * TakyonSchema calculates precise byte offsets for fields to map
 * standard object properties exactly into the C-ABI physical layout.
 */
/**
 * Every record starts and ends on this boundary, and so does the record bump.
 * Mirrors `align8` in `src/core/storage/recovery.zig`.
 */
export const RECORD_ALIGNMENT = 8;

/** Smallest multiple of `align` that is >= `value`. */
export function alignUp(value: number, align: number): number {
    return Math.ceil(value / align) * align;
}

export class TakyonSchema<T extends Record<string, FieldType>> {
    /** Compiled fields keyed by property name, in declaration order. */
    public readonly fields: Record<keyof T, FieldDefinition>;
    /**
     * Total record size in bytes, including the padding that aligns every
     * field and the tail. Always a multiple of {@link RECORD_ALIGNMENT}.
     */
    public readonly totalSize: number;

    /**
     * Fields are laid out in the order the object literal declares them, and
     * each one starts at the next multiple of its own alignment. A
     * JavaScript object preserves insertion order for string keys, so the
     * same literal always produces the same layout.
     *
     * The alignment is not cosmetic. The record bump is a shared byte
     * counter, and recovery re-derives it from the log and rounds it up to
     * {@link RECORD_ALIGNMENT} (`align8` in `finalize`). If records were
     * packed with no padding, a 20-byte record would leave the bump 4 bytes
     * short of the alignment on every restart, so the next record would be
     * allocated a few bytes further along than the log says -- and the index
     * rebuilt from that log would resolve keys to offsets that are no longer
     * record boundaries. Aligning the layout removes the disagreement at the
     * source instead of teaching two allocators to disagree carefully.
     *
     * The cost is a break in the on-disk contract: a record written by a
     * build that packed without padding is read at the wrong offsets by this
     * one, so the arena layout version moves and old segments are refused.
     *
     * @param schemaDef - Property name to field type. An empty object is
     *   rejected because a zero-size record has no meaningful offsets.
     * @throws {Error} If `schemaDef` is not a non-empty object, or names a
     *   type outside `FieldType`.
     */
    constructor(schemaDef: T) {
        if (schemaDef == null || typeof schemaDef !== 'object' || Object.keys(schemaDef).length === 0) {
            throw new Error("schema definition must be a non-empty object");
        }
        let currentOffset = 0;
        const compiledFields: Partial<Record<keyof T, FieldDefinition>> = {};

        for (const [key, type] of Object.entries(schemaDef)) {
            let size = 0;
            let align = 1;
            if (type === 'uint8') {
                size = 1;
            } else if (type === 'uint32') {
                size = 4;
                align = 4;
            } else if (type === 'float64') {
                size = 8;
                align = 8;
            } else if (type === 'string') {
                // A fat pointer: two 32-bit halves. Aligned as 8 anyway,
                // because the pointer it holds is a 64-bit arena offset and
                // because it is the last field in most schemas, so aligning
                // it costs nothing.
                size = 8;
                align = 8;
            } else throw new Error(`unknown field type '${type}' for '${key}'`);

            // Round the running offset up to this field's alignment.
            currentOffset = alignUp(currentOffset, align);
            compiledFields[key as keyof T] = {
                type,
                offset: currentOffset,
                size
            };

            currentOffset += size;
        }

        this.fields = compiledFields as Record<keyof T, FieldDefinition>;
        // The tail is padded too, so every record is a whole number of
        // alignment units and one record's padding never becomes the next
        // record's misalignment.
        this.totalSize = alignUp(currentOffset, RECORD_ALIGNMENT);
    }
}

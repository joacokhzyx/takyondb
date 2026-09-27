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
export class TakyonSchema<T extends Record<string, FieldType>> {
    /** Compiled fields keyed by property name, in declaration order. */
    public readonly fields: Record<keyof T, FieldDefinition>;
    /** Total record size in bytes, the sum of every field width. */
    public readonly totalSize: number;

    /**
     * Fields are packed with no padding, in the order the object literal
     * declares them. A JavaScript object preserves insertion order for
     * string keys, so the same literal always produces the same layout.
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
            if (type === 'uint8') size = 1;
            else if (type === 'uint32') size = 4;
            else if (type === 'float64') size = 8;
            else if (type === 'string') size = 8;
            else throw new Error(`unknown field type '${type}' for '${key}'`);
            
            compiledFields[key as keyof T] = {
                type,
                offset: currentOffset,
                size
            };
            
            currentOffset += size;
        }

        this.fields = compiledFields as Record<keyof T, FieldDefinition>;
        this.totalSize = currentOffset;
    }
}

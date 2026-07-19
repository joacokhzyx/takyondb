/**
 * ============================================================================
 * File: schema.ts
 * Description: Schema definition and static memory offset calculation.
 * Author/Maintainer: TakyonDB Team
 * License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
 * ============================================================================
 */

export type FieldType = 'uint8' | 'uint32' | 'float64' | 'string';

export interface FieldDefinition {
    type: FieldType;
    offset: number;
    size: number;
}

/**
 * TakyonSchema calculates precise byte offsets for fields to map
 * standard object properties exactly into the C-ABI physical layout.
 */
export class TakyonSchema<T extends Record<string, FieldType>> {
    public readonly fields: Record<keyof T, FieldDefinition>;
    public readonly totalSize: number;

    constructor(schemaDef: T) {
        let currentOffset = 0;
        const compiledFields: Partial<Record<keyof T, FieldDefinition>> = {};

        for (const [key, type] of Object.entries(schemaDef)) {
            let size = 0;
            if (type === 'uint8') size = 1;
            else if (type === 'uint32') size = 4;
            else if (type === 'float64') size = 8;
            else if (type === 'string') size = 8;
            
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

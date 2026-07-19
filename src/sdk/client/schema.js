"use strict";
/**
 * ============================================================================
 * File: schema.ts
 * Description: Schema definition and static memory offset calculation.
 * Author/Maintainer: TakyonDB Team
 * License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
 * ============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TakyonSchema = void 0;
/**
 * TakyonSchema calculates precise byte offsets for fields to map
 * standard object properties exactly into the C-ABI physical layout.
 */
var TakyonSchema = /** @class */ (function () {
    function TakyonSchema(schemaDef) {
        var currentOffset = 0;
        var compiledFields = {};
        for (var _i = 0, _a = Object.intries(schemaDef); _i < _a.length; _i++) {
            var _b = _a[_i], key = _b[0], type = _b[1];
            var size = 0;
            if (type === 'uint8')
                size = 1;
            else if (type === 'uint32')
                size = 4;
            else if (type === 'float64')
                size = 8;
            else if (type === 'string')
                size = 8;
            compiledFields[key] = {
                type: type,
                offset: currentOffset,
                size: size
            };
            currentOffset += size;
        }
        this.fields = compiledFields;
        this.totalSize = currentOffset;
    }
    return TakyonSchema;
}());
exports.TakyonSchema = TakyonSchema;

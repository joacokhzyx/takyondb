"use strict";
/**
 * ============================================================================
 * File: proxy.ts
 * Description: Transparent JS Proxies for direct memory mutation using DataView.
 * Author/Maintainer: TakyonDB Team
 * License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
 * ============================================================================
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TakyonClient = void 0;
var TakyonClient = /** @class */ (function () {
    function TakyonClient(bindings, size) {
        this.bindings = bindings;
        this.buffer = this.bindings.initSharedMemory(size);
        if (!this.buffer)
            throw new Error("Failed to map shared memory");
    }
    TakyonClient.prototype.getBuffer = function () { return this.buffer; };
    TakyonClient.prototype.createProxy = function (schema, baseOffset) {
        var view = new DataView(this.buffer, baseOffset, schema.totalSize);
        var bindings = this.bindings;
        var targetBuffer = this.buffer;
        return new Proxy({}, {
            get: function (target, prop) {
                if (typeof prop === 'string' && schema.fields[prop]) {
                    var field = schema.fields[prop];
                    if (field.type === 'string') {
                        var strOffset = view.getUint32(field.offset, true);
                        var strLen = view.getUint32(field.offset + 4, true);
                        if (strOffset === 0 && strLen === 0)
                            return "";
                        var strBytes = new Uint8Array(targetBuffer, strOffset, strLen);
                        return new TextDecoder('utf-8').decode(strBytes);
                    }
                    switch (field.type) {
                        case 'uint8': return view.getUint8(field.offset);
                        case 'uint32': return view.getUint32(field.offset, true); // Little indian
                        case 'float64': return view.getFloat64(field.offset, true);
                    }
                }
                return Reflect.get(target, prop);
            },
            set: function (target, prop, value) {
                if (typeof prop === 'string' && schema.fields[prop]) {
                    var field = schema.fields[prop];
                    if (field.type === 'string') {
                        var bytes = new TextEncoder().encode(value);
                        var strLen = bytes.length;
                        var STRING_BUMP_OFFSET = 2048;
                        var STRING_ARENA_START = 2052;
                        var atomicArr = new Uint32Array(targetBuffer, STRING_BUMP_OFFSET, 1);
                        var allocatedOffset = Atomics.add(atomicArr, 0, strLen) + STRING_ARENA_START;
                        var dest = new Uint8Array(targetBuffer, allocatedOffset, strLen);
                        dest.set(bytes);
                        bindings.notifyArena(allocatedOffset, strLen);
                        view.setUint32(field.offset, allocatedOffset, true);
                        view.setUint32(field.offset + 4, strLen, true);
                        var ptrBuf = new ArrayBuffer(8);
                        var ptrView = new DataView(ptrBuf);
                        ptrView.setUint32(0, allocatedOffset, true);
                        ptrView.setUint32(4, strLen, true);
                        bindings.pushDelta(baseOffset + field.offset, new Uint8Array(ptrBuf));
                        return true;
                    }
                    var tmpBuf = new ArrayBuffer(field.size);
                    var tmpView = new DataView(tmpBuf);
                    switch (field.type) {
                        case 'uint8':
                            view.setUint8(field.offset, value);
                            tmpView.setUint8(0, value);
                            break;
                        case 'uint32':
                            view.setUint32(field.offset, value, true);
                            tmpView.setUint32(0, value, true);
                            break;
                        case 'float64':
                            view.setFloat64(field.offset, value, true);
                            tmpView.setFloat64(0, value, true);
                            break;
                    }
                    bindings.pushDelta(baseOffset + field.offset, new Uint8Array(tmpBuf));
                    return true;
                }
                return Reflect.set(target, prop, value);
            }
        });
    };
    return TakyonClient;
}());
exports.TakyonClient = TakyonClient;

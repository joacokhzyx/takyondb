/**
 * ============================================================================
 * File: binding.cc
 * Description: Node-API (N-API) Bridge to interface V8 with TakyonDB C-ABI.
 * Author/Maintainer: TakyonDB Contributors
 * License: MIT. See LICENSE for details.
 * ============================================================================
 */

#include <node_api.h>
#include <stdint.h>
#include <string.h>
#include <new>

// NODE_GYP_MODULE_NAME is defined by node-gyp builds; zig builds define
// nothing, so fall back to the module name to keep both paths working.
#ifndef NODE_GYP_MODULE_NAME
#define NODE_GYP_MODULE_NAME takyondb_bridge
#endif

// Maximum inline delta payload accepted by takyon_write_delta.
#define TAKYON_MAX_INLINE 48
// Maximum key length accepted by the ART index (mirrors MAX_KEY_LEN).
#define TAKYON_MAX_KEY 256
// Sanity cap for shared-memory mapping requests (1 GiB).
#define TAKYON_MAX_SHM ((size_t)1024 * 1024 * 1024)

extern "C" {
    void* takyon_connect_shm(const char* name, size_t size);
    void takyon_disconnect_shm();
    int32_t takyon_write_delta(uint32_t offset, uint32_t size, const uint8_t* data);
    int32_t takyon_notify_arena(uint32_t offset, uint32_t size);
    int32_t takyon_verify_test_value();
    int takyon_insert_index(const char* key, uint32_t key_len, uint32_t value_offset);
    int takyon_search_index(const char* key, uint32_t key_len);
    int takyon_remove_index(const char* key, uint32_t key_len);
    int32_t takyon_scan_prefix(const char* key, uint32_t key_len, uint32_t* out, uint32_t out_cap);
    int32_t takyon_scan_range(const char* key, uint32_t key_len, const char* lo, uint32_t lo_len,
                              const char* hi, uint32_t hi_len, uint32_t* out, uint32_t out_cap);
    int32_t takyon_filter_u32(const uint32_t* values, uint32_t len, uint8_t op, uint32_t target,
                              uint32_t* out, uint32_t out_cap);
    int32_t takyon_filter_f64(const double* values, uint32_t len, uint8_t op, double target,
                              uint32_t* out, uint32_t out_cap);
    double takyon_agg_sum_f64(const double* values, uint32_t len);
    double takyon_agg_sum_selected(const double* values, uint32_t values_len,
                                   const uint32_t* sel, uint32_t sel_len);
    double takyon_agg_min_selected(const double* values, uint32_t values_len,
                                   const uint32_t* sel, uint32_t sel_len);
    double takyon_agg_max_selected(const double* values, uint32_t values_len,
                                   const uint32_t* sel, uint32_t sel_len);
    int32_t takyon_verify_record(const uint8_t* buf, uint32_t len);
    int32_t takyon_scrub_records(const uint8_t* buf, uint32_t len, uint32_t* ok_out,
                                 uint32_t* corrupt_out, uint32_t* bytes_out, uint32_t* truncated_out);
    int takyon_trigger_checkpoint();
    int takyon_start_vacuum(uint32_t string_offset);
    void takyon_stop_vacuum();
}

// Throw a JS Error when a N-API call fails; use at the top of handlers.
#define CHECK_NAPI(call)                                                  \
    do {                                                                  \
        napi_status status_ = (call);                                     \
        if (status_ != napi_ok) {                                         \
            const napi_extended_error_info* info_ = nullptr;              \
            napi_get_last_error_info((env), &info_);                      \
            const char* msg_ = (info_ && info_->error_message)            \
                ? info_->error_message                                    \
                : "N-API call failed";                                    \
            napi_throw_error((env), nullptr, msg_);                       \
            return nullptr;                                               \
        }                                                                 \
    } while (0)

#define REQUIRE_ARGC(n)                                                   \
    do {                                                                  \
        if (argc < (size_t)(n)) {                                         \
            napi_throw_type_error((env), nullptr, "wrong argument count"); \
            return nullptr;                                               \
        }                                                                 \
    } while (0)

// Runs when the external ArrayBuffer is GC'd. Intentionally a no-op: the
// engine owns a single process-wide SHM mapping with a refcount, and V8 may
// collect any individual buffer (workers routinely discard theirs right
// after connecting). Unmapping here once pulled live memory out from under
// concurrent workers (use-after-unmap, silent -1s, reused address ranges
// aliasing as corrupt index nodes). Teardown is explicit via
// disconnectSharedMemory() only.
static void ArrayBufferFinalizer(napi_env env, void* data, void* hint) {
    (void)env;
    (void)data;
    (void)hint;
}

napi_value InitSharedMemory(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    uint32_t size = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[0], &size));
    if (size == 0 || (size_t)size > TAKYON_MAX_SHM) {
        napi_throw_range_error(env, nullptr, "size must be between 1 and 1 GiB");
        return nullptr;
    }

    // NOTE: single-tenant build; the name argument of takyon_connect_shm is
    // currently fixed inside the engine. Multi-tenancy is future work.
    void* shm_ptr = takyon_connect_shm("shm://local", size);

    napi_value array_buffer;
    if (shm_ptr) {
        CHECK_NAPI(napi_create_external_arraybuffer(
            env, shm_ptr, size, ArrayBufferFinalizer, nullptr, &array_buffer));
    } else {
        CHECK_NAPI(napi_get_null(env, &array_buffer));
    }

    return array_buffer;
}

napi_value PushDelta(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(2);

    uint32_t offset = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[0], &offset));

    napi_typedarray_type array_type = napi_uint8_array;
    size_t length = 0;
    void* data = nullptr;
    CHECK_NAPI(napi_get_typedarray_info(
        env, args[1], &array_type, &length, &data, nullptr, nullptr));
    if (array_type != napi_uint8_array) {
        napi_throw_type_error(env, nullptr, "data must be a Uint8Array");
        return nullptr;
    }
    if (data == nullptr || length == 0 || length > TAKYON_MAX_INLINE) {
        napi_throw_range_error(env, nullptr, "data must be 1..48 bytes");
        return nullptr;
    }

    int status = takyon_write_delta(offset, (uint32_t)length, (const uint8_t*)data);

    napi_value result;
    CHECK_NAPI(napi_create_int32(env, status, &result));
    return result;
}

napi_value NotifyArena(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(2);

    uint32_t offset = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[0], &offset));

    uint32_t size = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[1], &size));

    int status = takyon_notify_arena(offset, size);

    napi_value result;
    CHECK_NAPI(napi_create_int32(env, status, &result));
    return result;
}

napi_value VerifyTestValue(napi_env env, napi_callback_info info) {
    (void)info;
    int val = takyon_verify_test_value();
    napi_value result;
    CHECK_NAPI(napi_create_int32(env, val, &result));
    return result;
}

// Copies a JS string into a stack buffer, rejecting over-long keys instead
// of silently truncating them (the old code passed the untruncated length
// with a truncated buffer).
static bool CopyKey(napi_env env, napi_value str, char out[TAKYON_MAX_KEY + 1],
                    uint32_t* out_len) {
    size_t key_len = 0;
    if (napi_get_value_string_utf8(env, str, nullptr, 0, &key_len) != napi_ok) {
        return false;
    }
    if (key_len == 0 || key_len > TAKYON_MAX_KEY) {
        napi_throw_range_error(env, nullptr, "key must be 1..256 bytes (UTF-8)");
        return false;
    }
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, str, out, TAKYON_MAX_KEY + 1, &copied) != napi_ok) {
        return false;
    }
    if (memchr(out, '\0', key_len) != nullptr) {
        napi_throw_range_error(env, nullptr, "key must not contain NUL bytes");
        return false;
    }
    *out_len = (uint32_t)copied;
    return true;
}

napi_value InsertIndex(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(2);

    char key[TAKYON_MAX_KEY + 1];
    uint32_t key_len = 0;
    if (!CopyKey(env, args[0], key, &key_len)) {
        return nullptr; // N-API error already thrown.
    }

    uint32_t value_offset = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[1], &value_offset));

    int status = takyon_insert_index(key, key_len, value_offset);

    napi_value result;
    CHECK_NAPI(napi_create_int32(env, status, &result));
    return result;
}

napi_value SearchIndex(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    char key[TAKYON_MAX_KEY + 1];
    uint32_t key_len = 0;
    if (!CopyKey(env, args[0], key, &key_len)) {
        return nullptr; // N-API error already thrown.
    }

    int32_t offset = takyon_search_index(key, key_len);

    napi_value result;
    CHECK_NAPI(napi_create_int32(env, offset, &result));
    return result;
}

napi_value RemoveIndex(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    char key[TAKYON_MAX_KEY + 1];
    uint32_t key_len = 0;
    if (!CopyKey(env, args[0], key, &key_len)) {
        return nullptr; // N-API error already thrown.
    }

    int32_t status = takyon_remove_index(key, key_len);

    napi_value result;
    CHECK_NAPI(napi_create_int32(env, status, &result));
    return result;
}

// Collects up to max_results (default 1024, cap 4096) value offsets whose
// keys start with the given prefix. Returns a Uint32Array (possibly empty).
// Rejects NUL-containing or over-long prefixes like the other key methods.
napi_value ScanPrefix(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    char key[TAKYON_MAX_KEY + 1];
    uint32_t key_len = 0;
    if (!CopyKey(env, args[0], key, &key_len)) {
        return nullptr; // N-API error already thrown.
    }

    uint32_t max_results = 1024;
    if (argc >= 2) {
        CHECK_NAPI(napi_get_value_uint32(env, args[1], &max_results));
        if (max_results == 0 || max_results > 4096) {
            napi_throw_range_error(env, nullptr, "max_results must be 1..4096");
            return nullptr;
        }
    }

    uint32_t out[4096];
    int32_t n = takyon_scan_prefix(key, key_len, out, max_results);
    if (n < 0) {
        napi_throw_error(env, nullptr, "scan_prefix failed: engine not ready");
        return nullptr;
    }

    void* data = nullptr;
    napi_value arraybuffer;
    CHECK_NAPI(napi_create_arraybuffer(env, (size_t)n * sizeof(uint32_t), &data, &arraybuffer));
    if (n > 0) {
        memcpy(data, out, (size_t)n * sizeof(uint32_t));
    }
    napi_value result;
    CHECK_NAPI(napi_create_typedarray(env, napi_uint32_array, (size_t)n, arraybuffer, 0, &result));
    return result;
}

// Reads a bound string (possibly empty, at most 256 UTF-8 bytes, NUL-free)
// for range scans. Unlike CopyKey, empty is allowed (means unbounded).
static bool CopyBound(napi_env env, napi_value str, char out[TAKYON_MAX_KEY + 1],
                      uint32_t* out_len) {
    size_t len = 0;
    if (napi_get_value_string_utf8(env, str, nullptr, 0, &len) != napi_ok) {
        return false;
    }
    if (len > TAKYON_MAX_KEY) {
        napi_throw_range_error(env, nullptr, "bound must be 0..256 bytes (UTF-8)");
        return false;
    }
    size_t copied = 0;
    if (napi_get_value_string_utf8(env, str, out, TAKYON_MAX_KEY + 1, &copied) != napi_ok) {
        return false;
    }
    if (memchr(out, '\0', len) != nullptr) {
        napi_throw_range_error(env, nullptr, "bound must not contain NUL bytes");
        return false;
    }
    *out_len = (uint32_t)copied;
    return true;
}

napi_value ScanRange(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value args[4];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    char key[TAKYON_MAX_KEY + 1];
    uint32_t key_len = 0;
    if (!CopyKey(env, args[0], key, &key_len)) {
        return nullptr; // N-API error already thrown.
    }

    char lo[TAKYON_MAX_KEY + 1] = {0};
    char hi[TAKYON_MAX_KEY + 1] = {0};
    uint32_t lo_len = 0, hi_len = 0;
    if (argc >= 2) {
        if (!CopyBound(env, args[1], lo, &lo_len)) return nullptr;
    }
    if (argc >= 3) {
        if (!CopyBound(env, args[2], hi, &hi_len)) return nullptr;
    }
    uint32_t max_results = 1024;
    if (argc >= 4) {
        CHECK_NAPI(napi_get_value_uint32(env, args[3], &max_results));
        if (max_results == 0 || max_results > 4096) {
            napi_throw_range_error(env, nullptr, "max_results must be 1..4096");
            return nullptr;
        }
    }

    uint32_t out[4096];
    int32_t n = takyon_scan_range(key, key_len, lo, lo_len, hi, hi_len, out, max_results);
    if (n < 0) {
        napi_throw_error(env, nullptr, "scan_range failed: engine not ready");
        return nullptr;
    }

    void* data = nullptr;
    napi_value arraybuffer;
    CHECK_NAPI(napi_create_arraybuffer(env, (size_t)n * sizeof(uint32_t), &data, &arraybuffer));
    if (n > 0) {
        memcpy(data, out, (size_t)n * sizeof(uint32_t));
    }
    napi_value result;
    CHECK_NAPI(napi_create_typedarray(env, napi_uint32_array, (size_t)n, arraybuffer, 0, &result));
    return result;
}

napi_value TriggerCheckpoint(napi_env env, napi_callback_info info) {    (void)info;
    int32_t result = ::takyon_trigger_checkpoint();
    napi_value res;
    CHECK_NAPI(napi_create_int32(env, result, &res));
    return res;
}
// Pushdown: filter a Uint32Array column, returning dense selection indices.
// Args: (values: Uint32Array, op: 0..5 Eq..Lte, target: uint32) -> Uint32Array.
napi_value FilterU32(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(3);

    napi_typedarray_type vtype = napi_uint8_array;
    size_t vlen = 0;
    void* vdata = nullptr;
    CHECK_NAPI(napi_get_typedarray_info(env, args[0], &vtype, &vlen, &vdata, nullptr, nullptr));
    if (vtype != napi_uint32_array) {
        napi_throw_type_error(env, nullptr, "values must be a Uint32Array");
        return nullptr;
    }
    uint32_t op = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[1], &op));
    if (op > 5) {
        napi_throw_range_error(env, nullptr, "op must be 0..5");
        return nullptr;
    }
    uint32_t target = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[2], &target));
    if (vlen == 0 || vlen > 100000000) {
        napi_throw_range_error(env, nullptr, "values length out of range");
        return nullptr;
    }

    uint32_t* out = new (std::nothrow) uint32_t[vlen];
    if (!out) {
        napi_throw_error(env, nullptr, "out of memory");
        return nullptr;
    }
    int32_t n = takyon_filter_u32((const uint32_t*)vdata, (uint32_t)vlen,
                                  (uint8_t)op, target, out, (uint32_t)vlen);
    napi_value result = nullptr;
    if (n >= 0) {
        void* data = nullptr;
        napi_value arraybuffer;
        napi_status st = napi_create_arraybuffer(env, (size_t)n * sizeof(uint32_t), &data, &arraybuffer);
        if (st == napi_ok) {
            if (n > 0) memcpy(data, out, (size_t)n * sizeof(uint32_t));
            st = napi_create_typedarray(env, napi_uint32_array, (size_t)n, arraybuffer, 0, &result);
        }
        if (st != napi_ok) {
            delete[] out;
            const napi_extended_error_info* info_ = nullptr;
            napi_get_last_error_info(env, &info_);
            napi_throw_error(env, nullptr, info_ && info_->error_message ? info_->error_message : "N-API call failed");
            return nullptr;
        }
    } else {
        delete[] out;
        napi_throw_error(env, nullptr, "filter_u32 failed");
        return nullptr;
    }
    delete[] out;
    return result;
}

// Pushdown: filter a Float64Array column. Args: (values: Float64Array, op: 0..5, target: number).
napi_value FilterF64(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(3);

    napi_typedarray_type vtype = napi_uint8_array;
    size_t vlen = 0;
    void* vdata = nullptr;
    CHECK_NAPI(napi_get_typedarray_info(env, args[0], &vtype, &vlen, &vdata, nullptr, nullptr));
    if (vtype != napi_float64_array) {
        napi_throw_type_error(env, nullptr, "values must be a Float64Array");
        return nullptr;
    }
    uint32_t op = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[1], &op));
    if (op > 5) {
        napi_throw_range_error(env, nullptr, "op must be 0..5");
        return nullptr;
    }
    double target = 0;
    CHECK_NAPI(napi_get_value_double(env, args[2], &target));
    if (vlen == 0 || vlen > 100000000) {
        napi_throw_range_error(env, nullptr, "values length out of range");
        return nullptr;
    }

    uint32_t* out = new (std::nothrow) uint32_t[vlen];
    if (!out) {
        napi_throw_error(env, nullptr, "out of memory");
        return nullptr;
    }
    int32_t n = takyon_filter_f64((const double*)vdata, (uint32_t)vlen,
                                  (uint8_t)op, target, out, (uint32_t)vlen);
    napi_value result = nullptr;
    if (n >= 0) {
        void* data = nullptr;
        napi_value arraybuffer;
        napi_status st = napi_create_arraybuffer(env, (size_t)n * sizeof(uint32_t), &data, &arraybuffer);
        if (st == napi_ok) {
            if (n > 0) memcpy(data, out, (size_t)n * sizeof(uint32_t));
            st = napi_create_typedarray(env, napi_uint32_array, (size_t)n, arraybuffer, 0, &result);
        }
        if (st != napi_ok) {
            delete[] out;
            const napi_extended_error_info* info_ = nullptr;
            napi_get_last_error_info(env, &info_);
            napi_throw_error(env, nullptr, info_ && info_->error_message ? info_->error_message : "N-API call failed");
            return nullptr;
        }
    } else {
        delete[] out;
        napi_throw_error(env, nullptr, "filter_f64 failed");
        return nullptr;
    }
    delete[] out;
    return result;
}

// Reads a Float64Array argument (allows empty).
static bool GetF64Array(napi_env env, napi_value arg, const double** out_data, uint32_t* out_len) {
    napi_typedarray_type t = napi_uint8_array;
    size_t len = 0;
    void* data = nullptr;
    if (napi_get_typedarray_info(env, arg, &t, &len, &data, nullptr, nullptr) != napi_ok) return false;
    if (t != napi_float64_array || len > 100000000) return false;
    *out_data = (const double*)data;
    *out_len = (uint32_t)len;
    return true;
}

// Reads a Uint32Array argument (allows empty).
static bool GetU32Array(napi_env env, napi_value arg, const uint32_t** out_data, uint32_t* out_len) {
    napi_typedarray_type t = napi_uint8_array;
    size_t len = 0;
    void* data = nullptr;
    if (napi_get_typedarray_info(env, arg, &t, &len, &data, nullptr, nullptr) != napi_ok) return false;
    if (t != napi_uint32_array || len > 100000000) return false;
    *out_data = (const uint32_t*)data;
    *out_len = (uint32_t)len;
    return true;
}

napi_value AggSum(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);
    const double* data = nullptr;
    uint32_t len = 0;
    if (!GetF64Array(env, args[0], &data, &len)) {
        napi_throw_type_error(env, nullptr, "values must be a Float64Array");
        return nullptr;
    }
    double sum = takyon_agg_sum_f64(len == 0 ? nullptr : data, len);
    napi_value result;
    CHECK_NAPI(napi_create_double(env, sum, &result));
    return result;
}

napi_value AggSumSelected(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(2);
    const double* data = nullptr;
    uint32_t len = 0;
    const uint32_t* sel = nullptr;
    uint32_t sel_len = 0;
    if (!GetF64Array(env, args[0], &data, &len) || !GetU32Array(env, args[1], &sel, &sel_len)) {
        napi_throw_type_error(env, nullptr, "expected (Float64Array, Uint32Array)");
        return nullptr;
    }
    double sum = takyon_agg_sum_selected(len == 0 ? nullptr : data, len,
                                         sel_len == 0 ? nullptr : sel, sel_len);
    napi_value result;
    CHECK_NAPI(napi_create_double(env, sum, &result));
    return result;
}

napi_value AggMinSelected(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(2);
    const double* data = nullptr;
    uint32_t len = 0;
    const uint32_t* sel = nullptr;
    uint32_t sel_len = 0;
    if (!GetF64Array(env, args[0], &data, &len) || !GetU32Array(env, args[1], &sel, &sel_len)) {
        napi_throw_type_error(env, nullptr, "expected (Float64Array, Uint32Array)");
        return nullptr;
    }
    double m = takyon_agg_min_selected(len == 0 ? nullptr : data, len,
                                       sel_len == 0 ? nullptr : sel, sel_len);
    napi_value result;
    CHECK_NAPI(napi_create_double(env, m, &result));
    return result;
}

napi_value AggMaxSelected(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(2);
    const double* data = nullptr;
    uint32_t len = 0;
    const uint32_t* sel = nullptr;
    uint32_t sel_len = 0;
    if (!GetF64Array(env, args[0], &data, &len) || !GetU32Array(env, args[1], &sel, &sel_len)) {
        napi_throw_type_error(env, nullptr, "expected (Float64Array, Uint32Array)");
        return nullptr;
    }
    double m = takyon_agg_max_selected(len == 0 ? nullptr : data, len,
                                       sel_len == 0 ? nullptr : sel, sel_len);
    napi_value result;
    CHECK_NAPI(napi_create_double(env, m, &result));
    return result;
}

napi_value StartVacuum(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    uint32_t string_offset = 0;
    CHECK_NAPI(napi_get_value_uint32(env, args[0], &string_offset));

    int status = takyon_start_vacuum(string_offset);

    napi_value result;
    CHECK_NAPI(napi_create_int32(env, status, &result));
    return result;
}
napi_value StopVacuum(napi_env env, napi_callback_info info) {
    (void)info;
    takyon_stop_vacuum();
    napi_value res;
    CHECK_NAPI(napi_create_int32(env, 0, &res));
    return res;
}

// Explicit process-wide engine teardown (unmap + close handle +
// invalidate state). Call only when no thread will touch the engine
// afterwards (end of process/tests). NOT called by the finalizer.
napi_value DisconnectShm(napi_env env, napi_callback_info info) {
    (void)info;
    takyon_disconnect_shm();
    napi_value res;
    CHECK_NAPI(napi_create_int32(env, 0, &res));
    return res;
}

// Scrubber: verifies one sealed envelope. Arg: Uint8Array -> boolean.
napi_value VerifyRecord(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    napi_typedarray_type t = napi_uint8_array;
    size_t len = 0;
    void* data = nullptr;
    CHECK_NAPI(napi_get_typedarray_info(env, args[0], &t, &len, &data, nullptr, nullptr));
    if (t != napi_uint8_array || len == 0 || len > 100000000) {
        napi_throw_type_error(env, nullptr, "buf must be a non-empty Uint8Array");
        return nullptr;
    }
    int32_t rc = takyon_verify_record((const uint8_t*)data, (uint32_t)len);
    napi_value result;
    CHECK_NAPI(napi_get_boolean(env, rc == 1, &result));
    return result;
}

// Scrubber: walks concatenated sealed envelopes. Arg: Uint8Array -> {ok, corrupt, bytes, truncated}.
napi_value ScrubRecords(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    CHECK_NAPI(napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    REQUIRE_ARGC(1);

    napi_typedarray_type t = napi_uint8_array;
    size_t len = 0;
    void* data = nullptr;
    CHECK_NAPI(napi_get_typedarray_info(env, args[0], &t, &len, &data, nullptr, nullptr));
    if (t != napi_uint8_array || len == 0 || len > 100000000) {
        napi_throw_type_error(env, nullptr, "buf must be a non-empty Uint8Array");
        return nullptr;
    }
    uint32_t ok = 0, corrupt = 0, bytes = 0, truncated = 0;
    int32_t rc = takyon_scrub_records((const uint8_t*)data, (uint32_t)len, &ok, &corrupt, &bytes, &truncated);
    if (rc != 0) {
        napi_throw_error(env, nullptr, "scrub_records failed");
        return nullptr;
    }
    napi_value obj, v;
    CHECK_NAPI(napi_create_object(env, &obj));
    CHECK_NAPI(napi_create_uint32(env, ok, &v));
    CHECK_NAPI(napi_set_named_property(env, obj, "ok", v));
    CHECK_NAPI(napi_create_uint32(env, corrupt, &v));
    CHECK_NAPI(napi_set_named_property(env, obj, "corrupt", v));
    CHECK_NAPI(napi_create_uint32(env, bytes, &v));
    CHECK_NAPI(napi_set_named_property(env, obj, "bytes", v));
    CHECK_NAPI(napi_get_boolean(env, truncated != 0, &v));
    CHECK_NAPI(napi_set_named_property(env, obj, "truncated", v));
    return obj;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        { "initSharedMemory", 0, InitSharedMemory, 0, 0, 0, napi_default, 0 },
        { "pushDelta", 0, PushDelta, 0, 0, 0, napi_default, 0 },
        { "notifyArena", 0, NotifyArena, 0, 0, 0, napi_default, 0 },
        { "verifyTestValue", 0, VerifyTestValue, 0, 0, 0, napi_default, 0 },
        { "insert_index", 0, InsertIndex, 0, 0, 0, napi_default, 0 },
        { "search_index", 0, SearchIndex, 0, 0, 0, napi_default, 0 },
        { "remove_index", 0, RemoveIndex, 0, 0, 0, napi_default, 0 },
        { "scan_prefix", 0, ScanPrefix, 0, 0, 0, napi_default, 0 },
        { "scan_range", 0, ScanRange, 0, 0, 0, napi_default, 0 },
        { "filter_u32", 0, FilterU32, 0, 0, 0, napi_default, 0 },
        { "filter_f64", 0, FilterF64, 0, 0, 0, napi_default, 0 },
        { "agg_sum", 0, AggSum, 0, 0, 0, napi_default, 0 },
        { "agg_sum_selected", 0, AggSumSelected, 0, 0, 0, napi_default, 0 },
        { "agg_min_selected", 0, AggMinSelected, 0, 0, 0, napi_default, 0 },
        { "agg_max_selected", 0, AggMaxSelected, 0, 0, 0, napi_default, 0 },
        { "verify_record", 0, VerifyRecord, 0, 0, 0, napi_default, 0 },
        { "scrub_records", 0, ScrubRecords, 0, 0, 0, napi_default, 0 },
        { "trigger_checkpoint", 0, TriggerCheckpoint, 0, 0, 0, napi_default, 0 },
        { "start_vacuum", 0, StartVacuum, 0, 0, 0, napi_default, 0 },
        { "stop_vacuum", 0, StopVacuum, 0, 0, 0, napi_default, 0 },
        { "disconnect_shm", 0, DisconnectShm, 0, 0, 0, napi_default, 0 }
    };
    CHECK_NAPI(napi_define_properties(env, exports, 21, desc));
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

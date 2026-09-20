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

napi_value TriggerCheckpoint(napi_env env, napi_callback_info info) {
    (void)info;
    int32_t result = ::takyon_trigger_checkpoint();
    napi_value res;
    CHECK_NAPI(napi_create_int32(env, result, &res));
    return res;
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

napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        { "initSharedMemory", 0, InitSharedMemory, 0, 0, 0, napi_default, 0 },
        { "pushDelta", 0, PushDelta, 0, 0, 0, napi_default, 0 },
        { "notifyArena", 0, NotifyArena, 0, 0, 0, napi_default, 0 },
        { "verifyTestValue", 0, VerifyTestValue, 0, 0, 0, napi_default, 0 },
        { "insert_index", 0, InsertIndex, 0, 0, 0, napi_default, 0 },
        { "search_index", 0, SearchIndex, 0, 0, 0, napi_default, 0 },
        { "remove_index", 0, RemoveIndex, 0, 0, 0, napi_default, 0 },
        { "trigger_checkpoint", 0, TriggerCheckpoint, 0, 0, 0, napi_default, 0 },
        { "start_vacuum", 0, StartVacuum, 0, 0, 0, napi_default, 0 },
        { "stop_vacuum", 0, StopVacuum, 0, 0, 0, napi_default, 0 },
        { "disconnect_shm", 0, DisconnectShm, 0, 0, 0, napi_default, 0 }
    };
    CHECK_NAPI(napi_define_properties(env, exports, 11, desc));
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

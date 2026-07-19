/**
 * ============================================================================
 * File: binding.cc
 * Description: Node-API (N-API) Bridge to interface V8 with TakyonDB C-ABI.
 * Author/Maintainer: TakyonDB Team
 * License: Dual Licensed (AGPLv3 / Commercial). See LICENSE for details.
 * ============================================================================
 */

#include <node_api.h>
#include <stdint.h>
#include <stdio.h>

extern "C" {
    void* takyon_connect_shm(const char* name, size_t size);
    int32_t takyon_write_delta(uint32_t offset, uint32_t size, const uint8_t* data);
    int32_t takyon_notify_arena(uint32_t offset, uint32_t size);
    int32_t takyon_verify_test_value();
    int takyon_insert_index(const char* key, uint32_t key_len, uint32_t value_offset);
    int takyon_search_index(const char* key, uint32_t key_len);
    int takyon_trigger_checkpoint();
    int takyon_start_vacuum(uint32_t string_offset);
}

napi_value InitSharedMemory(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    uint32_t size;
    napi_get_value_uint32(env, args[0], &size);

    void* shm_ptr = takyon_connect_shm("shm://local", size);

    napi_value array_buffer;
    if (shm_ptr) {
        napi_create_external_arraybuffer(env, shm_ptr, size, nullptr, nullptr, &array_buffer);
    } else {
        napi_get_null(env, &array_buffer);
    }

    return array_buffer;
}

napi_value PushDelta(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    uint32_t offset;
    napi_get_value_uint32(env, args[0], &offset);

    void* data;
    size_t length;
    napi_get_typedarray_info(env, args[1], nullptr, &length, &data, nullptr, nullptr);

    int status = takyon_write_delta(offset, (uint32_t)length, (const uint8_t*)data);
    
    napi_value result;
    napi_create_int32(env, status, &result);
    return result;
}

napi_value NotifyArena(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    uint32_t offset;
    napi_get_value_uint32(env, args[0], &offset);

    uint32_t size;
    napi_get_value_uint32(env, args[1], &size);

    int status = takyon_notify_arena(offset, size);
    
    napi_value result;
    napi_create_int32(env, status, &result);
    return result;
}

napi_value VerifyTestValue(napi_env env, napi_callback_info info) {
    int val = takyon_verify_test_value();
    napi_value result;
    napi_create_int32(env, val, &result);
    return result;
}

napi_value InsertIndex(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    size_t key_len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &key_len);
    char key[256];
    napi_get_value_string_utf8(env, args[0], key, sizeof(key), &key_len);

    uint32_t value_offset;
    napi_get_value_uint32(env, args[1], &value_offset);

    int status = takyon_insert_index(key, (uint32_t)key_len, value_offset);
    
    napi_value result;
    napi_create_int32(env, status, &result);
    return result;
}

napi_value SearchIndex(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    size_t key_len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &key_len);
    char key[256];
    napi_get_value_string_utf8(env, args[0], key, sizeof(key), &key_len);

    int32_t offset = takyon_search_index(key, (uint32_t)key_len);
    
    napi_value result;
    napi_create_int32(env, offset, &result);
    return result;
}

napi_value TriggerCheckpoint(napi_env env, napi_callback_info info) {
    int32_t result = ::takyon_trigger_checkpoint();
    napi_value res;
    napi_create_int32(env, result, &res);
    return res;
}

napi_value StartVacuum(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    uint32_t string_offset;
    napi_get_value_uint32(env, args[0], &string_offset);

    int status = takyon_start_vacuum(string_offset);
    
    napi_value result;
    napi_create_int32(env, status, &result);
    return result;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        { "initSharedMemory", 0, InitSharedMemory, 0, 0, 0, napi_default, 0 },
        { "pushDelta", 0, PushDelta, 0, 0, 0, napi_default, 0 },
        { "notifyArena", 0, NotifyArena, 0, 0, 0, napi_default, 0 },
        { "verifyTestValue", 0, VerifyTestValue, 0, 0, 0, napi_default, 0 },
        { "insert_index", 0, InsertIndex, 0, 0, 0, napi_default, 0 },
        { "search_index", 0, SearchIndex, 0, 0, 0, napi_default, 0 },
        { "trigger_checkpoint", 0, TriggerCheckpoint, 0, 0, 0, napi_default, 0 },
        { "start_vacuum", 0, StartVacuum, 0, 0, 0, napi_default, 0 }
    };
    napi_define_properties(env, exports, 8, desc);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

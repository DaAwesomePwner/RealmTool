#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include "forwarders.g.h"
#include "connect_hook.h"

// src/game/helperInstaller.ts looks for this string to tell our build from any other winhttp.dll.
extern "C" __declspec(dllexport) const char RealmToolHelperMarker[] = "RealmTool-Helper/1";

static DWORD WINAPI InitThread(LPVOID) {
    HMODULE self = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                            reinterpret_cast<LPCWSTR>(&InitThread), &self)) {
        OutputDebugStringA("[RealmTool helper] could not pin module\n");
    }
    // Avoid MinHook's thread suspension while Unity is inside il2cpp_init.
    Sleep(3000);
    if (!InstallConnectHook()) {
        OutputDebugStringA("[RealmTool helper] connect hook install failed; routing disabled\n");
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    switch (reason) {
        case DLL_PROCESS_ATTACH: {
            DisableThreadLibraryCalls(hinst);
            HANDLE thread = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
            if (thread) CloseHandle(thread);
            else OutputDebugStringA("[RealmTool helper] could not start init thread; routing disabled\n");
            break;
        }
        case DLL_PROCESS_DETACH:
            // The module is pinned for the process lifetime.
            break;
        default:
            break;
    }
    return TRUE;
}

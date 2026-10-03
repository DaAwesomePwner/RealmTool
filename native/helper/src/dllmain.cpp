#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include "forwarders.g.h"
#include "connect_hook.h"

// src/game/helperInstaller.ts looks for this string to tell our build from any other winhttp.dll.
extern "C" __declspec(dllexport) const char RealmToolHelperMarker[] = "RealmTool-Helper/1";

static DWORD WINAPI InitThread(LPVOID) {
    // Avoid MinHook's thread suspension while Unity is inside il2cpp_init.
    Sleep(3000);
    InstallConnectHook();
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved) {
    switch (reason) {
        case DLL_PROCESS_ATTACH: {
            DisableThreadLibraryCalls(hinst);
            HANDLE thread = CreateThread(nullptr, 0, InitThread, nullptr, 0, nullptr);
            if (thread) CloseHandle(thread);
            break;
        }
        case DLL_PROCESS_DETACH:
            // reserved != NULL: the process is exiting; unhooking under the loader lock is unsafe and pointless.
            if (reserved) break;
            RemoveConnectHook();
            break;
        default:
            break;
    }
    return TRUE;
}

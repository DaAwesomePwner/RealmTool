// Ported from realm-engine-client client/winhttp-proxy/src/connect_hook.cpp @ 9ab4f8f (MIT, see NOTICE).
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <cstdio>
#include <cstring>

#include "MinHook.h"
#include "connect_hook.h"

#pragma comment(lib, "ws2_32.lib")

namespace {

constexpr u_short kGamePort = 2050;

using connect_t = int(WSAAPI*)(SOCKET, const sockaddr*, int);
connect_t g_realConnect = nullptr;

void* g_connectTarget = nullptr;
bool  g_installed = false;

bool WriteWholeFile(const char* path, const char* text) {
    HANDLE h = CreateFileA(path, GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                           CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const DWORD length = static_cast<DWORD>(std::strlen(text));
    const BOOL success = WriteFile(h, text, length, &written, nullptr);
    CloseHandle(h);
    return success && written == length;
}

// %TEMP%\realmtool_target_<pid>.txt - read and deleted by src/routing/targetResolver.ts.
bool RecordOriginalTarget(const char* ipDottedQuad) {
    char tmpDir[MAX_PATH];
    DWORD n = GetTempPathA(MAX_PATH, tmpDir);
    if (n == 0 || n >= MAX_PATH) return false;

    char path[MAX_PATH];
    if (_snprintf_s(path, sizeof(path), _TRUNCATE,
                    "%srealmtool_target_%lu.txt", tmpDir, GetCurrentProcessId()) < 0) return false;
    return WriteWholeFile(path, ipDottedQuad);
}

int WSAAPI HookedConnect(SOCKET s, const sockaddr* name, int namelen) {
    if (name && namelen >= static_cast<int>(sizeof(sockaddr_in)) &&
        name->sa_family == AF_INET) {
        const sockaddr_in* in4 = reinterpret_cast<const sockaddr_in*>(name);

        if (in4->sin_port == htons(kGamePort)) {
            char ip[INET_ADDRSTRLEN] = {0};
            if (inet_ntop(AF_INET, &in4->sin_addr, ip, sizeof(ip)) != nullptr) {
                const bool isLoopback =
                    (std::strncmp(ip, "127.", 4) == 0);

                if (!isLoopback) {
                    if (RecordOriginalTarget(ip)) {
                        sockaddr_in redirected = *in4;
                        redirected.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
                        redirected.sin_port = htons(kGamePort);

                        return g_realConnect(
                            s, reinterpret_cast<const sockaddr*>(&redirected),
                            static_cast<int>(sizeof(redirected)));
                    }
                    OutputDebugStringA("[RealmTool helper] could not record target; connecting directly\n");
                }
            }
        }
    }

    return g_realConnect(s, name, namelen);
}

}

bool InstallConnectHook() {
    if (g_installed) return true;

    MH_STATUS st = MH_Initialize();
    if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) return false;

    HMODULE ws2 = LoadLibraryA("ws2_32.dll");
    if (!ws2) return false;

    g_connectTarget = reinterpret_cast<void*>(GetProcAddress(ws2, "connect"));
    if (!g_connectTarget) return false;

    if (MH_CreateHook(g_connectTarget, reinterpret_cast<void*>(&HookedConnect),
                      reinterpret_cast<void**>(&g_realConnect)) != MH_OK) {
        return false;
    }
    if (MH_EnableHook(g_connectTarget) != MH_OK) return false;

    g_installed = true;
    return true;
}

void RemoveConnectHook() {
    if (!g_installed) return;
    if (g_connectTarget) {
        MH_DisableHook(g_connectTarget);
        MH_RemoveHook(g_connectTarget);
        g_connectTarget = nullptr;
    }
    MH_Uninitialize();
    g_realConnect = nullptr;
    g_installed = false;
}

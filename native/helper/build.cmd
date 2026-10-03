@echo off
setlocal
set "ROOT=%~dp0"

if /I "%VSCMD_ARG_TGT_ARCH%"=="x64" goto build
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [helper] vswhere.exe not found. Install Visual Studio 2022 with "Desktop development with C++".
  exit /b 1
)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
  echo [helper] No Visual Studio install with x64 C++ tools found.
  exit /b 1
)
call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1

:build
set "MH=%ROOT%vendor\minhook"
if not exist "%ROOT%bin" mkdir "%ROOT%bin"
if not exist "%ROOT%obj" mkdir "%ROOT%obj"
cl /nologo /LD /O2 /MT /W3 /EHsc /std:c++17 ^
   /D_WIN32_WINNT=0x0A00 /DWIN32_LEAN_AND_MEAN ^
   /I "%ROOT%src" /I "%MH%" ^
   "%ROOT%src\dllmain.cpp" "%ROOT%src\connect_hook.cpp" ^
   "%MH%\hook.c" "%MH%\buffer.c" "%MH%\trampoline.c" "%MH%\hde\hde64.c" ^
   /Fo"%ROOT%obj\\" /Fe"%ROOT%bin\winhttp.dll" ^
   /link /DLL ws2_32.lib user32.lib
if errorlevel 1 exit /b 1
echo [helper] Built %ROOT%bin\winhttp.dll

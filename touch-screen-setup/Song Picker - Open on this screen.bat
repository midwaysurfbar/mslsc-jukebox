@echo off
rem Opens the Jukebox song picker full-screen (Chrome kiosk mode) on a touch screen.
rem
rem JUKEBOX  = the address of the PC running the MSLSC Jukebox. After the PC
rem            swap that is the HP (192.168.42.195). Change it here if it moves.
rem SCREEN_X = how far across the desktop the touch screen starts. 0 = the main
rem            screen. If the touch screen is a second screen to the right of a
rem            1920-wide main screen, use 1920.
rem
rem Uses its own Chrome profile, so it runs alongside the Bar Menu board's
rem Chrome without either one affecting the other. Close it with Alt+F4.
rem To start it automatically: put a shortcut to this file in
rem   shell:startup   (Win+R, type shell:startup, Enter)

set JUKEBOX=192.168.42.195
set SCREEN_X=1920

set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
if not exist "%CHROME%" (
  echo Google Chrome isn't installed on this PC - install it, then run this again.
  pause
  exit /b 1
)

start "" "%CHROME%" --user-data-dir="%LocalAppData%\MSLSC Song Picker" --kiosk --window-position=%SCREEN_X%,0 --no-first-run --disable-pinch --overscroll-history-navigation=0 --noerrdialogs --disable-session-crashed-bubble --disable-infobars "http://%JUKEBOX%:4610/"

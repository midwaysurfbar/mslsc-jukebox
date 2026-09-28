@echo off
rem Run ONCE on the PC that runs the MSLSC Jukebox, as administrator
rem (right-click -> Run as administrator).
rem
rem Lets touch screens on the club network reach the Jukebox's song picker
rem (port 4610). Only devices on the same local network can connect - and
rem only screens set up with a code from the Jukebox can add songs.

net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="MSLSC Jukebox song picker" >nul 2>&1
netsh advfirewall firewall add rule name="MSLSC Jukebox song picker" dir=in action=allow protocol=TCP localport=4610 remoteip=localsubnet profile=any
if errorlevel 1 (
  echo Something went wrong adding the firewall rule.
) else (
  echo Done - touch screens on the club network can now reach the song picker.
)
pause

@echo off
"C:\Program Files\Git\cmd\git.exe" add src/utils/telegramService.ts
"C:\Program Files\Git\cmd\git.exe" commit -m "Fallback to text message if photo upload fails"
"C:\Program Files\Git\cmd\git.exe" push origin main

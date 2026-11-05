$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ext = Join-Path $root 'extension'
Set-Clipboard -Value 'edge://extensions/'
Write-Host "本地双语字幕 更新助手" -ForegroundColor Cyan
Write-Host "已把 edge://extensions/ 复制到剪贴板。"
Write-Host ""
Write-Host "操作:" -ForegroundColor Yellow
Write-Host "  1. 切到 Edge，按 Ctrl+L，再按 Ctrl+V，回车"
Write-Host "  2. 找到「本地双语字幕 V1」，点卡片上的 重新加载 图标"
Write-Host "  3. 回到视频页面按 F5，再按 Z"
Write-Host ""
Write-Host "扩展目录已打开: $ext"
Start-Process explorer.exe -ArgumentList $ext
# 本地双语字幕 —— 原生宿主程序（Chrome native messaging host）
# 作用：让扩展无需“下载”即可直接读写本机笔记文件、弹出系统文件夹选择框、用系统默认程序（Word/WPS）打开文档。
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ScriptDir 'host-config.json'
$Config = @{ defaultDir = ''; searchRoots = @() }
if (Test-Path -LiteralPath $ConfigPath) {
  try {
    $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($raw.defaultDir) { $Config.defaultDir = [string]$raw.defaultDir }
    if ($raw.searchRoots) { $Config.searchRoots = @($raw.searchRoots | ForEach-Object { [string]$_ }) }
  } catch { }
}

function Read-Message {
  $stdin = [Console]::OpenStandardInput()
  $lenBuf = New-Object byte[] 4
  $got = 0
  while ($got -lt 4) {
    $n = $stdin.Read($lenBuf, $got, 4 - $got)
    if ($n -le 0) { return $null }
    $got += $n
  }
  $len = [BitConverter]::ToInt32($lenBuf, 0)
  if ($len -le 0) { return $null }
  $buf = New-Object byte[] $len
  $got = 0
  while ($got -lt $len) {
    $n = $stdin.Read($buf, $got, $len - $got)
    if ($n -le 0) { break }
    $got += $n
  }
  return [System.Text.Encoding]::UTF8.GetString($buf, 0, $got)
}

function Write-Message($payload) {
  $json = $payload | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $out = [Console]::OpenStandardOutput()
  $lenBuf = [BitConverter]::GetBytes([int]$bytes.Length)
  $out.Write($lenBuf, 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

function Note-Files($dir) {
  $list = @()
  if (Test-Path -LiteralPath $dir) {
    $items = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '\.(docx|txt|md|markdown)$' } | Sort-Object Name
    foreach ($it in $items) {
      $list += @{ name = $it.Name; size = [int]$it.Length; mtime = $it.LastWriteTime.ToString('yyyy-MM-dd HH:mm') }
    }
  }
  return , $list
}

function Find-Note($name, $roots, $depth) {
  foreach ($r in $roots) {
    if (-not $r) { continue }
    if (-not (Test-Path -LiteralPath $r)) { continue }
    $hit = Get-ChildItem -LiteralPath $r -Recurse -Depth $depth -File -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  return ''
}

$result = @{ ok = $false; error = '宿主程序未处理该请求' }
try {
  $text = Read-Message
  if (-not $text) {
    $result = @{ ok = $false; error = '没有收到请求' }
  }
  else {
    $msg = $text | ConvertFrom-Json
    $action = [string]$msg.action
    switch ($action) {
      'ping' {
        $result = @{ ok = $true; version = '1.0.0'; defaultDir = $Config.defaultDir; searchRoots = @($Config.searchRoots); user = $env:USERNAME }
      }
      'pick-dir' {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = '选择笔记保存文件夹'
        $dlg.ShowNewFolderButton = $true
        $start = [string]$msg.startDir
        if (-not $start) { $start = $Config.defaultDir }
        if ($start -and (Test-Path -LiteralPath $start)) { $dlg.SelectedPath = $start }
        $owner = New-Object System.Windows.Forms.Form
        $owner.FormBorderStyle = 'None'
        $owner.ShowInTaskbar = $false
        $owner.TopMost = $true
        $owner.StartPosition = 'Manual'
        $owner.Size = New-Object System.Drawing.Size(1, 1)
        $owner.Location = New-Object System.Drawing.Point(-4000, -4000)
        $owner.Show()
        $owner.Activate()
        $r = $dlg.ShowDialog($owner)
        try { $owner.Close(); $owner.Dispose() } catch { }
        if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $result = @{ ok = $true; picked = $true; dir = [string]$dlg.SelectedPath } }
        else { $result = @{ ok = $true; picked = $false; dir = '' } }
      }
      'list' {
        $dir = [string]$msg.dir
        if (-not $dir) { $dir = $Config.defaultDir }
        if (-not $dir) { $result = @{ ok = $false; error = '还没有设置文件夹' } }
        elseif (-not (Test-Path -LiteralPath $dir -PathType Container)) { $result = @{ ok = $false; error = '文件夹不存在'; code = 'ENOENT' } }
        else { $result = @{ ok = $true; dir = $dir; files = (Note-Files $dir) } }
      }
      'exists' {
        $p = [string]$msg.path
        $result = @{ ok = $true; path = $p; exists = [bool](Test-Path -LiteralPath $p) }
      }
      'read' {
        $p = [string]$msg.path
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $result = @{ ok = $false; error = '文件不存在'; code = 'ENOENT' } }
        else {
          $bytes = [System.IO.File]::ReadAllBytes($p)
          $result = @{ ok = $true; path = $p; size = $bytes.Length; base64 = [Convert]::ToBase64String($bytes) }
        }
      }
      'write' {
        $p = [string]$msg.path
        if (-not $p) { $result = @{ ok = $false; error = '缺少文件路径' } }
        else {
          $parent = Split-Path -Parent $p
          if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
          $bytes = [Convert]::FromBase64String([string]$msg.base64)
          [System.IO.File]::WriteAllBytes($p, $bytes)
          $result = @{ ok = $true; path = $p; size = $bytes.Length }
        }
      }
      'open' {
        $p = [string]$msg.path
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { $result = @{ ok = $false; error = '文件不存在'; code = 'ENOENT' } }
        else {
          $psi = New-Object System.Diagnostics.ProcessStartInfo
          $psi.FileName = $p
          $psi.UseShellExecute = $true
          $psi.WorkingDirectory = (Split-Path -Parent $p)
          [void][System.Diagnostics.Process]::Start($psi)
          $result = @{ ok = $true; path = $p }
        }
      }
      'reveal' {
        $p = [string]$msg.path
        if (Test-Path -LiteralPath $p -PathType Container) { Start-Process explorer.exe -ArgumentList ('"' + $p + '"') | Out-Null; $result = @{ ok = $true; path = $p } }
        elseif (Test-Path -LiteralPath $p) { Start-Process explorer.exe -ArgumentList ('/select,"' + $p + '"') | Out-Null; $result = @{ ok = $true; path = $p } }
        else { $result = @{ ok = $false; error = '路径不存在'; code = 'ENOENT' } }
      }
      'find' {
        $name = [string]$msg.name
        $roots = @()
        if ($Config.defaultDir) { $roots += $Config.defaultDir }
        if ($Config.searchRoots) { $roots += @($Config.searchRoots) }
        if ($msg.roots) { $roots += @($msg.roots | ForEach-Object { [string]$_ }) }
        $depth = 4
        if ($msg.depth) { $depth = [int]$msg.depth }
        $found = Find-Note $name $roots $depth
        if ($found) { $result = @{ ok = $true; name = $name; path = $found } }
        else { $result = @{ ok = $false; error = '没找到这个笔记文件'; code = 'ENOENT' } }
      }
      default { $result = @{ ok = $false; error = ('未知操作：' + $action) } }
    }
  }
}
catch { $result = @{ ok = $false; error = $_.Exception.Message } }
Write-Message $result

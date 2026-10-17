# 让树外安装的 dsh-manual-bg 能解析 @deepseek-ai/* 运行时包。
# 做法：在包内建一个 @deepseek-ai 目录 junction，指向 npm 全局 dsh 的依赖目录。
$ErrorActionPreference = 'Stop'
$pkg = Split-Path $PSScriptRoot -Parent
$target = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
if (-not (Test-Path $target)) { throw "找不到 harness 依赖目录: $target" }
$link = Join-Path $pkg 'node_modules\@deepseek-ai'
New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
        Write-Host "已存在链接: $link -> $($item.Target)"
        exit 0
    }
    throw "路径已存在且不是链接（拒绝覆盖）: $link"
}
New-Item -ItemType Junction -Path $link -Target $target | Out-Null
Write-Host "已创建 junction: $link -> $target"

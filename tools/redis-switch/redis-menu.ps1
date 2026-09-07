param([ValidateSet('menu','status','on','off')][string]$Action='menu',[switch]$NoPause)
$ErrorActionPreference='Stop'
$env:PYTHONIOENCODING='utf-8'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
$menuMode=($Action -eq 'menu')
$resultCode=0
function Invoke-RedisAction([string]$SelectedAction) {
    $pythonCommand=Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) {throw '未找到 Python，请先安装 Python 3.10 或以上版本。'}
    & $pythonCommand.Source -u (Join-Path $PSScriptRoot 'redis_switch.py') $SelectedAction
    $script:resultCode=$LASTEXITCODE
}
do {
    try {
        if ($menuMode) {
            Write-Host ''
            Write-Host '北辰 Redis 开关 1.0.1' -ForegroundColor Cyan
            Write-Host '1 查看状态   2 开启   3 关闭   4 查看操作记录   0 退出'
            Write-Host '关闭会销毁 Redis 并清空云端会话。操作期间请保持窗口打开。'
            $choice=(Read-Host '请输入数字').Trim()
            switch ($choice) {
                '1' {$Action='status'}
                '2' {$Action='on'}
                '3' {$Action='off'}
                '4' {
                    $logPath=Join-Path $PSScriptRoot 'redis-switch.log'
                    if (Test-Path -LiteralPath $logPath) {Get-Content -LiteralPath $logPath -Encoding UTF8 -Tail 60 | Out-Host}
                    else {Write-Host '暂时没有操作记录。'}
                    continue
                }
                '0' {exit 0}
                default {Write-Host '请输入 0 至 4。';continue}
            }
            if ($choice -notin @('1','2','3')) {continue}
        }
        Invoke-RedisAction $Action
        switch ($resultCode) {
            0 {Write-Host '操作完成，以上方云端确认结果为准。' -ForegroundColor Green}
            2 {Write-Host '主要操作已完成，但仍有附属检查或哨兵警告，请查看上方提示。' -ForegroundColor Yellow}
            3 {Write-Host '已取消，没有执行变更。' -ForegroundColor Yellow}
            default {Write-Host '操作未确认完成。记录已保存，请查看状态后再重试。' -ForegroundColor Red}
        }
    } catch {
        Write-Host $_.Exception.Message -ForegroundColor Red
        $resultCode=1
    }
    if (-not $NoPause) {
        if ($menuMode) {Read-Host '按回车返回菜单（记录不会清除）' | Out-Null}
        else {Read-Host '按回车关闭窗口' | Out-Null}
    }
} while ($menuMode -and -not $NoPause)
exit $resultCode

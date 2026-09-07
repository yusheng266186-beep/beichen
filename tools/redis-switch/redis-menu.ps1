param([ValidateSet('menu','status','on','off')][string]$Action='menu',[switch]$NoPause)
$ErrorActionPreference='Stop'
$env:PYTHONIOENCODING='utf-8'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
function Invoke-RedisAction([string]$SelectedAction) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) { throw '未找到 Python，请先安装 Python 3.10 或以上版本。' }
    & $pythonCommand.Source (Join-Path $PSScriptRoot 'redis_switch.py') $SelectedAction | Out-Host
    return $LASTEXITCODE
}
try {
    if ($Action -eq 'menu') {
        Write-Host '北辰 Redis 开关'
        Write-Host '1. 查看状态  2. 开启并恢复服务  3. 关闭并停止使用  0. 退出'
        Write-Host '关闭会销毁 Redis 并清空云端会话状态。开启需要账户余额充足。'
        $choice=Read-Host '请输入数字'
        switch ($choice) {
            '1' {$Action='status'}
            '2' {$Action='on'}
            '3' {$Action='off'}
            '0' {exit 0}
            default {throw '请输入 0、1、2 或 3。'}
        }
    }
    $resultCode=Invoke-RedisAction $Action
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $resultCode=1
}
if (-not $NoPause) {Read-Host '按回车关闭窗口' | Out-Null}
exit $resultCode

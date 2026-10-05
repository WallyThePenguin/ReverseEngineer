<#
  The fence a test puts up before it runs control.ps1's stopping and starting with Windows faked.
  CI runs those tests on the PC that is also the live Hearth's (D66), as you, and install.ps1 gave
  your account the right to stop Hearth's services and end Jarvis's task. So Assert-Fenced follows
  every command the functions under test can reach, and throws unless each is one of the test's
  fakes, one of control.ps1's own functions (followed in turn), or a cmdlet that only filters,
  prints or tells the time. Asking only that a fake be a function isn't enough: Windows' own
  Stop-ScheduledTask and Start-ScheduledTask are functions too (the ScheduledTasks module's).
  ProgramData must be moved first: Hearth's services folder is found through it, and a stop
  request written there ends the live Jarvis.
  Commands only: a .NET call is checked just by name, against those that act ($acting).
#>

# $Entry: the functions the test calls. $Faked: commands that must be the test's fakes, whatever
# they're reached from. $Fakes: the test's files. $Code: Hearth's files whose functions are followed.
function Assert-Fenced([string[]]$Entry, [string[]]$Faked, [string[]]$Fakes, [string[]]$Code) {
  $harmless = "ForEach-Object", "Where-Object", "Select-Object", "Sort-Object", "Measure-Object",
    "Write-Host", "Write-Warning", "Write-Verbose", "Out-Null", "Out-String", "Get-Date"
  $acting = "Kill", "Stop", "Start", "Run", "RunEx", "Terminate", "Delete", "DeleteTask", "RegisterTaskDefinition",
    "Open", "Create", "Move", "Copy", "WriteAllText", "WriteAllLines", "WriteAllBytes", "AppendAllText"
  $problems = @()
  $real = [Environment]::GetFolderPath("CommonApplicationData")
  if (-not $env:ProgramData -or "$env:ProgramData\".StartsWith("$real\", "OrdinalIgnoreCase")) {
    $problems += "ProgramData is still $real, where Hearth's services folder is"
  }
  $resolve = { param($name) Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1 }
  $fileOf = { param($c) if ($c -and "$($c.CommandType)" -eq "Function") { $c.ScriptBlock.File } }
  foreach ($name in $Faked) {
    if ($Fakes -notcontains (& $fileOf (& $resolve $name))) { $problems += "$name isn't the test's fake" }
  }
  $seen = @{}
  $todo = [System.Collections.Generic.Queue[string]]::new()
  foreach ($name in $Entry) { $todo.Enqueue($name) }
  while ($todo.Count) {
    $name = $todo.Dequeue()
    if ($seen.ContainsKey($name)) { continue }
    $seen[$name] = $true
    $command = & $resolve $name
    $file = & $fileOf $command
    if ($file -and $Fakes -contains $file) { continue }
    if ($file -and $Code -contains $file) {
      $ast = $command.ScriptBlock.Ast
      foreach ($call in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.CommandAst] }, $true)) {
        $called = $call.GetCommandName()
        if ($called) { $todo.Enqueue($called) } else { $problems += "$name runs a command it doesn't name: $($call.Extent.Text)" }
      }
      foreach ($call in $ast.FindAll({ $args[0] -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true)) {
        if ($acting -contains "$($call.Member.Extent.Text)") { $problems += "$name calls $($call.Extent.Text)" }
      }
      continue
    }
    if ($harmless -notcontains $name -or "$($command.CommandType)" -ne "Cmdlet") {
      $problems += "$name ($(if ($command) { "$($command.CommandType) $($command.Source)".Trim() } else { 'not found' })) isn't faked"
    }
  }
  if ($problems) {
    throw "Not running $($Entry -join ', ') here, where they could reach the live Hearth (D66): $($problems -join '; ')."
  }
}

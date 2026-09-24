$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$null = Add-Type -AssemblyName UIAutomationClient
$null = Add-Type -AssemblyName UIAutomationTypes
$null = Add-Type -AssemblyName System.Drawing
$null = Add-Type -AssemblyName System.Windows.Forms
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JupiterNativeUi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
'@

function New-Failure([string]$Code, [string]$Message, [string]$Mode = 'WINDOWS_UI_AUTOMATION') {
  return [ordered]@{
    success = $false
    observation = $Message
    interactionMode = $Mode
    evidence = @()
    error = [ordered]@{ code = $Code; message = $Message; recoverable = $true }
  }
}

function New-Success([string]$Observation, [string]$Mode, $Output = $null, $Evidence = @()) {
  $response = [ordered]@{
    success = $true
    observation = $Observation
    interactionMode = $Mode
    evidence = @($Evidence)
  }
  if ($null -ne $Output) { $response.output = $Output }
  return $response
}

function Get-TargetProcess($Action) {
  if ($null -ne $Action.target.processId) {
    return Get-Process -Id ([int]$Action.target.processId) -ErrorAction Stop
  }
  if ($Action.target.windowTitle) {
    return Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$($Action.target.windowTitle)*"
    } | Sort-Object StartTime -Descending | Select-Object -First 1
  }
  throw 'The target does not identify a process or window.'
}

function Wait-MainWindow([int]$ProcessId, [int]$TimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.MainWindowHandle -ne 0) { return $process }
    Start-Sleep -Milliseconds 75
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'The exact application window did not become available before the timeout.'
}

function Get-WindowRoot($Action) {
  $process = Get-TargetProcess $Action
  if ($null -eq $process -or $process.MainWindowHandle -eq 0) {
    throw 'The exact target window is unavailable.'
  }
  return [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
}

function Get-ControlType([string]$Name) {
  switch ($Name) {
    'Document' { return [System.Windows.Automation.ControlType]::Document }
    'Edit' { return [System.Windows.Automation.ControlType]::Edit }
    'Button' { return [System.Windows.Automation.ControlType]::Button }
    'MenuItem' { return [System.Windows.Automation.ControlType]::MenuItem }
    'Window' { return [System.Windows.Automation.ControlType]::Window }
    'ListItem' { return [System.Windows.Automation.ControlType]::ListItem }
    default { throw "Unsupported semantic control type: $Name" }
  }
}

function Find-SemanticElement($Root, $Selector) {
  if ($null -eq $Selector) { throw 'A semantic element selector is required.' }
  $conditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
  if ($Selector.automationId) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
      [string]$Selector.automationId
    ))
  }
  if ($Selector.name) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      [string]$Selector.name
    ))
  }
  if ($Selector.className) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty,
      [string]$Selector.className
    ))
  }
  if ($Selector.controlType) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      (Get-ControlType ([string]$Selector.controlType))
    ))
  }
  if ($conditions.Count -eq 0) { throw 'The semantic selector is empty.' }
  $condition = if ($conditions.Count -eq 1) {
    $conditions[0]
  } else {
    [System.Windows.Automation.AndCondition]::new($conditions.ToArray())
  }
  return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Invoke-Element($Element) {
  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    return $true
  }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
    return $true
  }
  return $false
}

function Get-UiTree($Root, [int]$MaxDepth, [int]$MaxNodes) {
  $nodes = [System.Collections.Generic.List[object]]::new()
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  function Visit-Node($Element, [int]$Depth) {
    if ($null -eq $Element -or $Depth -gt $MaxDepth -or $nodes.Count -ge $MaxNodes) { return }
    $nodes.Add([ordered]@{
      name = [string]$Element.Current.Name
      automationId = [string]$Element.Current.AutomationId
      controlType = ([string]$Element.Current.ControlType.ProgrammaticName).Replace('ControlType.', '')
      className = [string]$Element.Current.ClassName
      depth = $Depth
      enabled = [bool]$Element.Current.IsEnabled
    })
    $child = $walker.GetFirstChild($Element)
    while ($null -ne $child -and $nodes.Count -lt $MaxNodes) {
      Visit-Node $child ($Depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  }
  $first = $walker.GetFirstChild($Root)
  while ($null -ne $first -and $nodes.Count -lt $MaxNodes) {
    Visit-Node $first 0
    $first = $walker.GetNextSibling($first)
  }
  return @($nodes)
}

function Convert-Keys($Keys) {
  $modifiers = ''
  $key = $null
  foreach ($tokenValue in $Keys) {
    $token = ([string]$tokenValue).ToUpperInvariant()
    switch ($token) {
      'CTRL' { $modifiers += '^' }
      'ALT' { $modifiers += '%' }
      'SHIFT' { $modifiers += '+' }
      'ENTER' { $key = '{ENTER}' }
      'TAB' { $key = '{TAB}' }
      'ESCAPE' { $key = '{ESC}' }
      'DELETE' { $key = '{DELETE}' }
      'BACKSPACE' { $key = '{BACKSPACE}' }
      default {
        if ($token -notmatch '^[A-Z0-9]$') { throw "Unsupported keyboard token: $token" }
        $key = $token.ToLowerInvariant()
      }
    }
  }
  if ($null -eq $key) { throw 'The keyboard shortcut has no terminal key.' }
  return "$modifiers$key"
}

function Wait-ElementByNameAndProcess([string]$Name, [int]$ProcessId, [int]$TimeoutMs) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $processCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    $ProcessId
  )
  $nameCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  $condition = [System.Windows.Automation.AndCondition]::new($processCondition, $nameCondition)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -ne $element) { return $element }
    Start-Sleep -Milliseconds 75
  } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}

function Invoke-NotepadSave($Action) {
  $path = [IO.Path]::GetFullPath([string]$Action.parameters.outputPath)
  if ([IO.File]::Exists($path) -and -not [bool]$Action.parameters.overwrite) {
    return New-Failure 'TARGET_FILE_EXISTS' 'The exact target file already exists and overwrite was not approved.' 'WINDOWS_API'
  }
  $parent = [IO.Path]::GetDirectoryName($path)
  if (-not [IO.Directory]::Exists($parent)) {
    return New-Failure 'TARGET_DIRECTORY_MISSING' 'The exact approved target directory does not exist.' 'WINDOWS_API'
  }
  $process = Get-TargetProcess $Action
  $root = Get-WindowRoot $Action
  $fileMenu = Find-SemanticElement $root ([pscustomobject]@{ name = 'File' })
  $saveAsInvoked = $false
  if ($null -ne $fileMenu -and (Invoke-Element $fileMenu)) {
    Start-Sleep -Milliseconds 150
    $saveAs = Wait-ElementByNameAndProcess 'Save as' $process.Id 1500
    if ($null -ne $saveAs) { $saveAsInvoked = Invoke-Element $saveAs }
  }
  if (-not $saveAsInvoked) {
    $null = [JupiterNativeUi]::SetForegroundWindow([IntPtr]$process.MainWindowHandle)
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    [System.Windows.Forms.SendKeys]::SendWait('^+s')
  }
  $dialog = Wait-ElementByNameAndProcess 'Save as' $process.Id 5000
  if ($null -eq $dialog) {
    return New-Failure 'SAVE_DIALOG_MISSING' 'The real Save as dialog did not appear.'
  }
  Start-Sleep -Milliseconds 150
  $automationId = [System.Windows.Automation.AutomationElement]::AutomationIdProperty
  $className = [System.Windows.Automation.AutomationElement]::ClassNameProperty
  $filenameCondition = [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new($automationId, '1001'),
    [System.Windows.Automation.PropertyCondition]::new($className, 'Edit')
  )
  $saveCondition = [System.Windows.Automation.AndCondition]::new(
    [System.Windows.Automation.PropertyCondition]::new($automationId, '1'),
    [System.Windows.Automation.PropertyCondition]::new($className, 'Button')
  )
  $filename = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $filenameCondition)
  $saveButton = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $saveCondition)
  if ($null -eq $filename -or $filename.Current.NativeWindowHandle -eq 0 -or
      $null -eq $saveButton -or $saveButton.Current.NativeWindowHandle -eq 0) {
    return New-Failure 'SAVE_DIALOG_CONTROL_MISSING' 'The semantic Save dialog controls could not be resolved.'
  }
  $null = [JupiterNativeUi]::SendMessage(
    [IntPtr]$filename.Current.NativeWindowHandle,
    0x000C,
    [IntPtr]::Zero,
    $path
  )
  $null = [JupiterNativeUi]::SendMessage(
    [IntPtr]$saveButton.Current.NativeWindowHandle,
    0x00F5,
    [IntPtr]::Zero,
    [IntPtr]::Zero
  )
  if ([IO.File]::Exists($path) -and [bool]$Action.parameters.overwrite) {
    Start-Sleep -Milliseconds 200
    $confirm = Wait-ElementByNameAndProcess 'Yes' $process.Id 1500
    if ($null -ne $confirm) { $null = Invoke-Element $confirm }
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$Action.timeoutMs)
  do {
    if ([IO.File]::Exists($path)) {
      $actual = [IO.File]::ReadAllText($path)
      if ($actual -ne [string]$Action.parameters.expectedContent) {
        return New-Failure 'FILE_CONTENT_MISMATCH' 'The saved file exists but its content does not match the approved text.' 'WINDOWS_API'
      }
      $file = Get-Item -LiteralPath $path
      $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
      $evidence = [ordered]@{
        kind = 'file'
        path = $path
        mediaType = 'text/plain'
        sha256 = $hash
        sizeBytes = [int64]$file.Length
        verified = $true
      }
      return New-Success 'The exact file exists and its content matches the approved text.' 'WINDOWS_API' ([ordered]@{ fileVerified = $true }) @($evidence)
    }
    Start-Sleep -Milliseconds 75
  } while ([DateTime]::UtcNow -lt $deadline)
  return New-Failure 'FILE_NOT_CREATED' 'Notepad did not create the exact approved file before the timeout.' 'WINDOWS_API'
}

function Invoke-Action($Action) {
  switch ([string]$Action.action) {
    'OPEN_APP' {
      $executable = [string]$Action.parameters.executable
      $leaf = [IO.Path]::GetFileName($executable).ToLowerInvariant()
      if ($leaf -notin @('notepad.exe', 'explorer.exe')) {
        return New-Failure 'EXECUTABLE_NOT_ALLOWED' 'The initial SET 8 adapter allows only Notepad and File Explorer.' 'WINDOWS_API'
      }
      $start = @{ FilePath = $executable; PassThru = $true }
      if ($Action.parameters.arguments.Count -gt 0) { $start.ArgumentList = @($Action.parameters.arguments) }
      if ($Action.parameters.workingDirectory) { $start.WorkingDirectory = [string]$Action.parameters.workingDirectory }
      $started = Start-Process @start
      $process = Wait-MainWindow $started.Id ([int]$Action.timeoutMs)
      return New-Success 'The real Windows application opened and exposed a window.' 'WINDOWS_API' ([ordered]@{
        processId = [int]$process.Id
        windowHandle = ([int64]$process.MainWindowHandle).ToString()
        windowTitle = [string]$process.MainWindowTitle
      })
    }
    'WAIT_FOR_WINDOW' {
      $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$Action.timeoutMs)
      do {
        $candidate = if ($null -ne $Action.target.processId) {
          Get-Process -Id ([int]$Action.target.processId) -ErrorAction SilentlyContinue
        } elseif ($Action.parameters.processName) {
          Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension([string]$Action.parameters.processName)) -ErrorAction SilentlyContinue |
            Sort-Object StartTime -Descending | Select-Object -First 1
        }
        if ($null -ne $candidate -and $candidate.MainWindowHandle -ne 0 -and
            (-not $Action.parameters.titleContains -or $candidate.MainWindowTitle -like "*$($Action.parameters.titleContains)*")) {
          return New-Success 'The exact window reached the requested state.' 'WINDOWS_UI_AUTOMATION' ([ordered]@{
            processId = [int]$candidate.Id
            windowHandle = ([int64]$candidate.MainWindowHandle).ToString()
            windowTitle = [string]$candidate.MainWindowTitle
          })
        }
        Start-Sleep -Milliseconds 75
      } while ([DateTime]::UtcNow -lt $deadline)
      return New-Failure 'WINDOW_WAIT_TIMEOUT' 'The exact window was not observed before the timeout.'
    }
    'FOCUS_WINDOW' {
      $process = Get-TargetProcess $Action
      if (-not [JupiterNativeUi]::SetForegroundWindow([IntPtr]$process.MainWindowHandle)) {
        return New-Failure 'WINDOW_FOCUS_FAILED' 'Windows did not focus the exact target window.' 'WINDOWS_API'
      }
      return New-Success 'Windows focused the exact target window.' 'WINDOWS_API' ([ordered]@{
        processId = [int]$process.Id
        windowHandle = ([int64]$process.MainWindowHandle).ToString()
        windowTitle = [string]$process.MainWindowTitle
      })
    }
    'MINIMIZE_WINDOW' {
      $process = Get-TargetProcess $Action
      $null = [JupiterNativeUi]::ShowWindow([IntPtr]$process.MainWindowHandle, 6)
      return New-Success 'The exact target window was minimized.' 'WINDOWS_API'
    }
    'MAXIMIZE_WINDOW' {
      $process = Get-TargetProcess $Action
      $null = [JupiterNativeUi]::ShowWindow([IntPtr]$process.MainWindowHandle, 3)
      return New-Success 'The exact target window was maximized.' 'WINDOWS_API'
    }
    'RESTORE_WINDOW' {
      $process = Get-TargetProcess $Action
      $null = [JupiterNativeUi]::ShowWindow([IntPtr]$process.MainWindowHandle, 9)
      return New-Success 'The exact target window was restored.' 'WINDOWS_API'
    }
    'MOVE_RESIZE_WINDOW' {
      $process = Get-TargetProcess $Action
      $changed = [JupiterNativeUi]::SetWindowPos(
        [IntPtr]$process.MainWindowHandle,
        [IntPtr]::Zero,
        [int]$Action.parameters.x,
        [int]$Action.parameters.y,
        [int]$Action.parameters.width,
        [int]$Action.parameters.height,
        0x0004
      )
      if (-not $changed) {
        return New-Failure 'WINDOW_BOUNDS_CHANGE_FAILED' 'Windows rejected the exact move and resize request.' 'WINDOWS_API'
      }
      return New-Success 'The exact target window was moved and resized.' 'WINDOWS_API'
    }
    'ENUMERATE_WINDOWS' {
      $windows = @(Get-Process | Where-Object {
        $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)
      } | Sort-Object Id | Select-Object -First ([int]$Action.parameters.limit) | ForEach-Object {
        [ordered]@{
          processId = [int]$_.Id
          windowHandle = ([int64]$_.MainWindowHandle).ToString()
          windowTitle = [string]$_.MainWindowTitle
        }
      })
      return New-Success 'Visible top-level application windows were enumerated.' 'WINDOWS_API' ([ordered]@{ windows = $windows })
    }
    'GET_ACTIVE_WINDOW' {
      $handle = [JupiterNativeUi]::GetForegroundWindow()
      if ($handle -eq [IntPtr]::Zero) {
        return New-Failure 'ACTIVE_WINDOW_UNAVAILABLE' 'Windows did not expose an active window.' 'WINDOWS_API'
      }
      $process = Get-Process | Where-Object { $_.MainWindowHandle -eq $handle } | Select-Object -First 1
      if ($null -eq $process) {
        return New-Failure 'ACTIVE_WINDOW_PROCESS_UNAVAILABLE' 'The active window process could not be resolved.' 'WINDOWS_API'
      }
      return New-Success 'The active Windows application was observed.' 'WINDOWS_API' ([ordered]@{
        processId = [int]$process.Id
        windowHandle = ([int64]$handle).ToString()
        windowTitle = [string]$process.MainWindowTitle
      })
    }
    'CLOSE_APP' {
      $process = Get-TargetProcess $Action
      if (-not $process.CloseMainWindow()) {
        return New-Failure 'WINDOW_CLOSE_REJECTED' 'The application rejected a graceful close request.' 'WINDOWS_API'
      }
      if (-not $process.WaitForExit([int]$Action.timeoutMs)) {
        return New-Failure 'WINDOW_CLOSE_TIMEOUT' 'The application did not close at a safe boundary.' 'WINDOWS_API'
      }
      return New-Success 'The exact application closed gracefully.' 'WINDOWS_API'
    }
    'TYPE_TEXT' {
      $root = Get-WindowRoot $Action
      $element = Find-SemanticElement $root $Action.target.selector
      if ($null -eq $element) { return New-Failure 'UI_ELEMENT_NOT_FOUND' 'The semantic text control was not found.' }
      $pattern = $null
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        return New-Failure 'UI_VALUE_PATTERN_UNAVAILABLE' 'The semantic control does not support text entry.'
      }
      ([System.Windows.Automation.ValuePattern]$pattern).SetValue([string]$Action.parameters.text)
      return New-Success 'Text was entered into the re-resolved semantic control.' 'WINDOWS_UI_AUTOMATION'
    }
    'CLICK_ELEMENT' {
      $root = Get-WindowRoot $Action
      $element = Find-SemanticElement $root $Action.target.selector
      if ($null -ne $element -and (Invoke-Element $element)) {
        return New-Success 'The re-resolved semantic control was invoked.' 'WINDOWS_UI_AUTOMATION'
      }
      if ($null -eq $Action.parameters.coordinateFallback) {
        return New-Failure 'UI_ELEMENT_NOT_FOUND' 'The semantic control was not found and coordinate fallback was not approved.'
      }
      $bounds = $Action.parameters.coordinateFallback.bounds
      $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
      if ($bounds.x -lt $virtual.Left -or $bounds.y -lt $virtual.Top -or
          ($bounds.x + $bounds.width) -gt $virtual.Right -or
          ($bounds.y + $bounds.height) -gt $virtual.Bottom) {
        return New-Failure 'COORDINATE_BOUNDS_INVALID' 'The approved fallback rectangle is outside the current virtual screen.' 'COORDINATE_FALLBACK'
      }
      $x = [int]($bounds.x + [Math]::Floor($bounds.width / 2))
      $y = [int]($bounds.y + [Math]::Floor($bounds.height / 2))
      if (-not [JupiterNativeUi]::SetCursorPos($x, $y)) {
        return New-Failure 'COORDINATE_MOVE_FAILED' 'Windows rejected the approved coordinate fallback.' 'COORDINATE_FALLBACK'
      }
      [JupiterNativeUi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      [JupiterNativeUi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      return New-Success 'The explicitly approved constrained coordinate fallback was used.' 'COORDINATE_FALLBACK'
    }
    'PRESS_KEYS' {
      $process = Get-TargetProcess $Action
      $null = [JupiterNativeUi]::SetForegroundWindow([IntPtr]$process.MainWindowHandle)
      Start-Sleep -Milliseconds 75
      [System.Windows.Forms.SendKeys]::SendWait((Convert-Keys $Action.parameters.keys))
      return New-Success 'The approved semantic keyboard shortcut was sent to the exact window.' 'SEMANTIC_KEYBOARD'
    }
    'SCROLL_ELEMENT' {
      $root = Get-WindowRoot $Action
      $element = Find-SemanticElement $root $Action.target.selector
      if ($null -eq $element) { return New-Failure 'UI_ELEMENT_NOT_FOUND' 'The semantic scroll control was not found.' }
      $pattern = $null
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern)) {
        return New-Failure 'UI_SCROLL_PATTERN_UNAVAILABLE' 'The semantic control does not support scrolling.'
      }
      $none = [System.Windows.Automation.ScrollAmount]::NoAmount
      $small = [System.Windows.Automation.ScrollAmount]::SmallIncrement
      $large = [System.Windows.Automation.ScrollAmount]::LargeIncrement
      $smallBack = [System.Windows.Automation.ScrollAmount]::SmallDecrement
      $largeBack = [System.Windows.Automation.ScrollAmount]::LargeDecrement
      $forward = if ($Action.parameters.amount -eq 'LARGE') { $large } else { $small }
      $back = if ($Action.parameters.amount -eq 'LARGE') { $largeBack } else { $smallBack }
      switch ([string]$Action.parameters.direction) {
        'UP' { ([System.Windows.Automation.ScrollPattern]$pattern).Scroll($none, $back) }
        'DOWN' { ([System.Windows.Automation.ScrollPattern]$pattern).Scroll($none, $forward) }
        'LEFT' { ([System.Windows.Automation.ScrollPattern]$pattern).Scroll($back, $none) }
        'RIGHT' { ([System.Windows.Automation.ScrollPattern]$pattern).Scroll($forward, $none) }
      }
      return New-Success 'The re-resolved semantic control was scrolled.' 'WINDOWS_UI_AUTOMATION'
    }
    'SELECT_ELEMENT' {
      $root = Get-WindowRoot $Action
      $element = Find-SemanticElement $root $Action.target.selector
      if ($null -eq $element) { return New-Failure 'UI_ELEMENT_NOT_FOUND' 'The semantic selectable control was not found.' }
      $pattern = $null
      if (-not $element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        return New-Failure 'UI_SELECTION_PATTERN_UNAVAILABLE' 'The semantic control does not support selection.'
      }
      ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
      return New-Success 'The re-resolved semantic control was selected.' 'WINDOWS_UI_AUTOMATION'
    }
    'DRAG_DROP' {
      $root = Get-WindowRoot $Action
      $source = Find-SemanticElement $root $Action.target.selector
      $destination = Find-SemanticElement $root $Action.parameters.destination
      if ($null -eq $source -or $null -eq $destination) {
        return New-Failure 'UI_ELEMENT_NOT_FOUND' 'The semantic drag source or destination was not found.'
      }
      $sourceRect = $source.Current.BoundingRectangle
      $destinationRect = $destination.Current.BoundingRectangle
      if ($sourceRect.IsEmpty -or $destinationRect.IsEmpty) {
        return New-Failure 'UI_ELEMENT_BOUNDS_UNAVAILABLE' 'A semantic drag target has no current screen bounds.'
      }
      $sourceX = [int]($sourceRect.Left + ($sourceRect.Width / 2))
      $sourceY = [int]($sourceRect.Top + ($sourceRect.Height / 2))
      $destinationX = [int]($destinationRect.Left + ($destinationRect.Width / 2))
      $destinationY = [int]($destinationRect.Top + ($destinationRect.Height / 2))
      if (-not [JupiterNativeUi]::SetCursorPos($sourceX, $sourceY)) {
        return New-Failure 'DRAG_SOURCE_UNAVAILABLE' 'Windows rejected the re-resolved semantic drag source.'
      }
      [JupiterNativeUi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 100
      $null = [JupiterNativeUi]::SetCursorPos($destinationX, $destinationY)
      Start-Sleep -Milliseconds 100
      [JupiterNativeUi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      return New-Success 'The re-resolved semantic element was dragged to the semantic destination.' 'WINDOWS_UI_AUTOMATION'
    }
    'COPY' {
      $root = Get-WindowRoot $Action
      if ($null -ne $Action.target.selector) {
        $element = Find-SemanticElement $root $Action.target.selector
        if ($null -eq $element) { return New-Failure 'UI_ELEMENT_NOT_FOUND' 'The semantic copy control was not found.' }
        $element.SetFocus()
      }
      [System.Windows.Forms.SendKeys]::SendWait('^c')
      return New-Success 'The copy command was sent to the exact semantic target.' 'SEMANTIC_KEYBOARD'
    }
    'PASTE' {
      $root = Get-WindowRoot $Action
      if ($null -ne $Action.target.selector) {
        $element = Find-SemanticElement $root $Action.target.selector
        if ($null -eq $element) { return New-Failure 'UI_ELEMENT_NOT_FOUND' 'The semantic paste control was not found.' }
        $element.SetFocus()
      }
      [System.Windows.Forms.Clipboard]::SetText([string]$Action.parameters.text)
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      return New-Success 'The approved text was pasted into the exact semantic target.' 'SEMANTIC_KEYBOARD'
    }
    'READ_UI_TREE' {
      $root = Get-WindowRoot $Action
      $nodes = Get-UiTree $root ([int]$Action.parameters.maxDepth) ([int]$Action.parameters.maxNodes)
      return New-Success 'The current semantic UI hierarchy was observed.' 'WINDOWS_UI_AUTOMATION' ([ordered]@{
        nodeCount = [int]$nodes.Count
        uiTree = @($nodes)
      })
    }
    'SCREENSHOT' {
      $path = [IO.Path]::GetFullPath([string]$Action.parameters.outputPath)
      $parent = [IO.Path]::GetDirectoryName($path)
      if (-not [IO.Directory]::Exists($parent)) {
        return New-Failure 'TARGET_DIRECTORY_MISSING' 'The exact screenshot directory does not exist.' 'WINDOWS_API'
      }
      $process = Get-TargetProcess $Action
      $rect = [JupiterNativeUi+RECT]::new()
      if (-not [JupiterNativeUi]::GetWindowRect([IntPtr]$process.MainWindowHandle, [ref]$rect)) {
        return New-Failure 'WINDOW_BOUNDS_UNAVAILABLE' 'Windows did not return bounds for the exact window.' 'WINDOWS_API'
      }
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      $bitmap = [System.Drawing.Bitmap]::new($width, $height)
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try { $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
        $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      } finally { $bitmap.Dispose() }
      $file = Get-Item -LiteralPath $path
      $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
      return New-Success 'A real screenshot of the exact window was captured.' 'WINDOWS_API' $null @([ordered]@{
        kind = 'screenshot'; path = $path; mediaType = 'image/png'; sha256 = $hash
        sizeBytes = [int64]$file.Length; verified = $true
      })
    }
    'SAVE_FILE' { return Invoke-NotepadSave $Action }
    default { return New-Failure 'ACTION_UNSUPPORTED' 'The typed action is not supported by this runtime.' 'WINDOWS_API' }
  }
}

try {
  $json = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($json)) { throw 'The automation request was empty.' }
  $request = $json | ConvertFrom-Json
  $result = Invoke-Action $request
} catch {
  $sanitized = ([string]$_.Exception.Message -replace '[\r\n\t]+', ' ').Trim()
  if ($sanitized.Length -gt 300) { $sanitized = $sanitized.Substring(0, 300) }
  if ([string]::IsNullOrWhiteSpace($sanitized)) {
    $sanitized = 'The isolated automation host encountered a sanitized failure.'
  }
  $result = New-Failure 'AUTOMATION_HOST_ERROR' $sanitized 'WINDOWS_API'
}

[Console]::Out.Write(($result | ConvertTo-Json -Depth 30 -Compress))

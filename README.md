# pi-powershell-native

A Windows PowerShell tool for [pi](https://pi.dev).

When installed, this extension replaces the built-in `bash` tool with a native
`powershell` tool on Windows. It also routes the interactive `!command` and
`!!command` shortcuts through PowerShell.

## Installation

```bash
pi install git:github.com/karutoil/pi-powershell-native
```

Or copy `extensions/powershell-native.ts` to:

```text
%USERPROFILE%\.pi\agent\extensions\powershell-native.ts
```

## Requirements

- Windows
- PowerShell (`powershell.exe`) or PowerShell Core (`pwsh.exe`)
  - `pwsh.exe` is preferred if it is on `PATH`
  - Override with `PI_POWERSHELL_PATH`

## Usage

After installation, the model will use the `powershell` tool for all shell
commands on Windows. The built-in `bash` tool is disabled automatically.

Example prompts:

```text
List the files in the current directory.
Run git status.
Find all TypeScript files in src.
```

### Output tips

PowerShell cmdlets return objects, not plain strings. If output looks empty or
oddly formatted, pipe to `Out-String` (e.g. `Get-ChildItem | Out-String`) or
access a specific property (e.g. `(Get-Location).Path`).

## Configuration

Set the environment variable below before starting pi if you want to use a
specific PowerShell executable:

```powershell
$env:PI_POWERSHELL_PATH = "C:\Program Files\PowerShell\7\pwsh.exe"
```

## License

MIT

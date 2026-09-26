$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$frontendRoot = Join-Path $appRoot 'frontend'
$distIndex = Join-Path $frontendRoot 'dist\index.html'
$hostAddress = '127.0.0.1'
$port = 80
$url = 'http://championfit.localhost/app/overview'
$healthUrl = "http://${hostAddress}:${port}/app/overview"
$stateRoot = Join-Path $env:LOCALAPPDATA 'Champion Fit'
$startupLog = Join-Path $stateRoot 'startup.log'
$buildLog = Join-Path $stateRoot 'build.log'
$serverStdout = Join-Path $stateRoot 'server.log'
$serverStderr = Join-Path $stateRoot 'server-error.log'

New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null

function Write-StartupLog([string]$Message) {
    Add-Content -LiteralPath $startupLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

function Test-ChampionFitPage {
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 2
        return ($response.StatusCode -eq 200)
    }
    catch {
        return $false
    }
}

try {
    $frontendInputs = @(
        (Join-Path $frontendRoot 'index.html'),
        (Join-Path $frontendRoot 'package.json'),
        (Join-Path $frontendRoot 'package-lock.json'),
        (Join-Path $frontendRoot 'tsconfig.json'),
        (Join-Path $frontendRoot 'vite.config.ts')
    ) | Where-Object { Test-Path -LiteralPath $_ }
    $frontendInputs += Get-ChildItem (Join-Path $frontendRoot 'src') -Recurse -File | Select-Object -ExpandProperty FullName

    $needsBuild = -not (Test-Path -LiteralPath $distIndex)
    if (-not $needsBuild) {
        $distTimestamp = (Get-Item -LiteralPath $distIndex).LastWriteTimeUtc
        $latestSourceTimestamp = ($frontendInputs | ForEach-Object {
            (Get-Item -LiteralPath $_).LastWriteTimeUtc
        } | Measure-Object -Maximum).Maximum
        $needsBuild = $latestSourceTimestamp -gt $distTimestamp
    }

    if ($needsBuild) {
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $npm) {
            throw 'La build frontend è assente o non aggiornata e npm.cmd non è disponibile.'
        }
        Write-StartupLog 'Build frontend necessaria; avvio npm run build.'
        & $npm.Source --prefix $frontendRoot run build *> $buildLog
        if ($LASTEXITCODE -ne 0) {
            if (Test-Path -LiteralPath $distIndex) {
                Write-StartupLog "Build frontend fallita con codice $LASTEXITCODE; uso l'ultima build disponibile. Dettagli: $buildLog"
            }
            else {
                throw "Build frontend fallita con codice $LASTEXITCODE e non esiste una build precedente. Consulta $buildLog."
            }
        }
    }

    if (-not (Test-ChampionFitPage)) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listener) {
            throw "La porta $port è già occupata da un altro server."
        }

        $python = Join-Path $appRoot '.venv\Scripts\python.exe'
        if (-not (Test-Path -LiteralPath $python)) {
            $pythonCommand = Get-Command python.exe -ErrorAction Stop | Select-Object -First 1
            $python = $pythonCommand.Source
        }
        $serverScript = Join-Path $appRoot 'app.py'
        Write-StartupLog "Avvio server su $url usando $python."
        $server = Start-Process -FilePath $python `
            -ArgumentList "`"$serverScript`" --host $hostAddress --port $port" `
            -WorkingDirectory $appRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput $serverStdout `
            -RedirectStandardError $serverStderr `
            -PassThru

        $ready = $false
        for ($attempt = 0; $attempt -lt 45; $attempt++) {
            if (Test-ChampionFitPage) {
                $ready = $true
                break
            }
            $server.Refresh()
            if ($server.HasExited) {
                throw "Il server è terminato all'avvio (codice $($server.ExitCode)); consulta $serverStderr."
            }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) {
            throw "Il server non ha risposto entro 45 secondi; consulta $serverStderr."
        }
    }

    $firefoxCandidates = @(
        (Join-Path $env:ProgramFiles 'Mozilla Firefox\firefox.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Mozilla Firefox\firefox.exe'),
        (Join-Path $env:LOCALAPPDATA 'Mozilla Firefox\firefox.exe')
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $firefoxCommand = Get-Command firefox.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $firefox = if ($firefoxCommand) { $firefoxCommand.Source } else { $firefoxCandidates | Select-Object -First 1 }

    if ($firefox) {
        Start-Process -FilePath $firefox -ArgumentList "-new-tab `"$url`""
        Write-StartupLog "Pagina aperta in Firefox: $url"
    }
    else {
        Start-Process -FilePath $url
        Write-StartupLog "Firefox non trovato; indirizzo aperto nel browser predefinito: $url"
    }
}
catch {
    Write-StartupLog "ERRORE: $($_.Exception.Message)"
    throw
}

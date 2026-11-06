# © 2026 Nokia
#
# Licensed under the 5G-MAG Public License (v1.0)

<#
  run-encoder.ps1 — standalone native encode (+ optional decode), no Node/npm required.

  Mirrors the command line built by encode-decode.mjs so you can test encoder.cfg on its own.
  encoder.cfg is the single source of truth for codec options — this script only supplies the
  paths, frame range, sequence bbox and HM/hdrconvert configs on the command line.

  Usage:
    ./run-encoder.ps1                       # frame 445, 1 frame, INTRA, encode + decode
    ./run-encoder.ps1 -Frame 445 -Count 3 -Inter
    ./run-encoder.ps1 -OutDir C:\tmp\enc    # explicit output folder
    ./run-encoder.ps1 -NoDecode             # encode only
#>
[CmdletBinding()]
param(
  [int]$Frame = 445,
  [int]$Count = 1,
  [switch]$Inter,
  [string]$OutDir,
  [switch]$NoDecode
)

$ErrorActionPreference = 'Stop'

# Native tools (encode.exe/decode.exe) spawn/echo through the console; piping their output through a
# PowerShell pipeline can break the in-process HM encoder. Use Start-Process with file redirection
# (like Node's spawnSync file redirect) and gate on the real exit code.
function Invoke-Native {
  param([string]$Exe, [string[]]$CmdArgs, [string]$LogFile, [string]$WorkDir)
  $errFile = "$LogFile.err"
  $p = Start-Process -FilePath $Exe -ArgumentList $CmdArgs -WorkingDirectory $WorkDir `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $errFile
  # Keep stderr as a sidecar (.err) only if non-empty; avoids a merge that can race the file handle.
  if ((Test-Path $errFile) -and (Get-Item $errFile).Length -eq 0) {
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  }
  Get-Content $LogFile -Tail 3 | ForEach-Object { Write-Host "      $_" }
  if ($p.ExitCode -ne 0) { throw "$(Split-Path -Leaf $Exe) exited with $($p.ExitCode) (see $(Split-Path -Leaf $LogFile))" }
}

# --------------------------------------------------------------------------- paths / config
$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $Here
$TmBin     = Join-Path $RepoRoot 'tm-reference\bin'
$TmCfgHm   = Join-Path $RepoRoot 'tm-reference\cfg\hm'
$TmCfgHdr  = Join-Path $RepoRoot 'tm-reference\cfg\hdrconvert'
$EncodeExe = Join-Path $TmBin 'encode.exe'
$DecodeExe = Join-Path $TmBin 'decode.exe'
$InputDir  = 'C:\Projects\input\football_voxelized'
$CfgFile   = Join-Path $Here 'encoder.cfg'

# Football sequence quantization box (sequences.yaml seq-id 7); the input is the pre-quantized
# integer mesh (football_fr%04d_qp12_qt13.obj: 12-bit pos, 13-bit texcoords).
$SeqMinPos     = '0.00728459982,-0.00232295995,-0.0394272991'
$SeqMaxPos     = '1023.96997,980.596008,966.742004'
$SrcMeshSuffix = '_qp12_qt13'

foreach ($p in @($EncodeExe, $DecodeExe, $CfgFile)) {
  if (-not (Test-Path $p)) { throw "required file not found: $p" }
}

if (-not $OutDir) {
  $stamp  = (Get-Date).ToString('yyMMddHHmm')
  $OutDir = Join-Path $Here "runs\enc.$stamp\reference"
  for ($n = 1; Test-Path $OutDir; $n++) {
    $OutDir = Join-Path $Here "runs\enc.${stamp}_$n\reference"
  }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$DispCfg = if ($Inter) { 'displacements-ld.cfg' } else { 'displacements-ai.cfg' }
$TexCfg  = if ($Inter) { 'texture-ld.cfg' }       else { 'texture-ai.cfg' }
$Frames  = $Frame..($Frame + [Math]::Max(1, $Count) - 1)

Write-Host "[enc] out folder : $OutDir"
Write-Host ("[enc] frames     : {0}..{1}  mode {2}" -f $Frame, ($Frame + $Frames.Count - 1), ($(if ($Inter) { 'INTER (ld, P-frames)' } else { 'INTRA (ai)' })))

# ---- stage source frames as frame_%04d.obj/.png ----
foreach ($f in $Frames) {
  $f4     = '{0:D4}' -f $f
  $srcObj = Join-Path $InputDir ("football_fr{0}{1}.obj" -f $f4, $SrcMeshSuffix)
  $srcPng = Join-Path $InputDir ("football_fr{0}.png" -f $f4)
  if (-not (Test-Path $srcObj)) { throw "missing source mesh: $srcObj" }
  Copy-Item $srcObj (Join-Path $OutDir "frame_$f4.obj") -Force
  if (Test-Path $srcPng) { Copy-Item $srcPng (Join-Path $OutDir "frame_$f4.png") -Force }
}

Push-Location $OutDir
try {
  # ---- encode ----
  $encArgs = @(
    "--config=$CfgFile"
    '--srcMesh=frame_%04d.obj'
    '--srcTex=frame_%04d.png'
    "--startFrameIndex=$Frame"
    "--frameCount=$($Frames.Count)"
    "--minPosition=$SeqMinPos"
    "--maxPosition=$SeqMaxPos"
    "--analyzeGof=$(if ($Inter) { 1 } else { 0 })"
    '--compressed=out.vmesh'
    '--recMesh=rec_%04d.obj'
    '--recMat=rec_%04d.mtl'
    "--geometryVideoEncoderConfig=$(Join-Path $TmCfgHm $DispCfg)"
    "--textureVideoEncoderConfig=$(Join-Path $TmCfgHm $TexCfg)"
    "--textureVideoEncoderConvertConfig=$(Join-Path $TmCfgHdr 'bgr444toyuv420.cfg')"
    "--textureVideoDecoderConvertConfig=$(Join-Path $TmCfgHdr 'yuv420tobgr444.cfg')"
  )
  Write-Host "[enc] run: encode.exe $($encArgs -join ' ')"
  Invoke-Native -Exe $EncodeExe -CmdArgs $encArgs -LogFile (Join-Path $OutDir 'encoder.log') -WorkDir $OutDir
  if (-not (Test-Path (Join-Path $OutDir 'out.vmesh'))) { throw 'encoder did not produce out.vmesh' }
  Write-Host "[ ok ] encoded: out.vmesh ($((Get-Item (Join-Path $OutDir 'out.vmesh')).Length) B)"

  # ---- decode ----
  if (-not $NoDecode) {
    $decArgs = @(
      '--compressed=out.vmesh'
      '--decMesh=decoded_%04d.obj'
      '--decMat=decoded_%04d.mtl'
      '--decTex=decoded_%04d.png'
      "--textureVideoDecoderConvertConfig=$(Join-Path $TmCfgHdr 'yuv420tobgr444.cfg')"
    )
    Write-Host "[enc] run: decode.exe $($decArgs -join ' ')"
    Invoke-Native -Exe $DecodeExe -CmdArgs $decArgs -LogFile (Join-Path $OutDir 'decoder.log') -WorkDir $OutDir
    Write-Host "[ ok ] decoded -> decoded_%04d.obj/.png"
  }
}
finally {
  Pop-Location
}

Write-Host "[done] artifacts in $OutDir"

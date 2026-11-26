$ErrorActionPreference = "Stop"
$root = "C:\Users\SATISFAIT\.gemini\antigravity\scratch\iptv-vuma-app"
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$bt = "$sdk\build-tools\35.0.0"
$androidJar = "$sdk\platforms\android-35\android.jar"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$downloads = "$root\downloads"
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

# 1. Build Windows .exe
Write-Host "Building KibangouTV-Windows.exe..."
& $csc /nologo /target:winexe /out:"$downloads\KibangouTV-Windows.exe" "$root\apps\windows\KibangouTV.cs"
if ($LASTEXITCODE -ne 0) { throw "Windows build failed" }

# 2. Ensure debug keystore
$keystore = "$root\apps\kibangou-release.keystore"
if (!(Test-Path $keystore)) {
    & keytool -genkeypair -v -keystore $keystore -storepass kibangou2026 -keypass kibangou2026 -alias kibangou -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=KibangouTV, O=KibangouTV, C=CG" | Out-Null
}

function Build-AndroidApk($name, $appDir, $outApk) {
    Write-Host "Building $name..."
    $buildDir = "$appDir\build"
    if (Test-Path $buildDir) { Remove-Item -Recurse -Force $buildDir }
    New-Item -ItemType Directory -Force -Path "$buildDir\res\drawable", "$buildDir\compiled", "$buildDir\classes", "$buildDir\dex" | Out-Null
    Copy-Item "$root\icon-192.png" "$buildDir\res\drawable\ic_launcher.png"

    & "$bt\aapt2.exe" compile --dir "$buildDir\res" -o "$buildDir\res.zip"
    if ($LASTEXITCODE -ne 0) { throw "$name aapt2 compile failed" }

    & "$bt\aapt2.exe" link -o "$buildDir\unaligned.apk" -I $androidJar --manifest "$appDir\AndroidManifest.xml" "$buildDir\res.zip" --java "$buildDir\gen"
    if ($LASTEXITCODE -ne 0) { throw "$name aapt2 link failed" }

    $javaFiles = Get-ChildItem -Recurse -Filter "*.java" -Path "$appDir\src", "$buildDir\gen" | ForEach-Object { $_.FullName }
    & javac -source 11 -target 11 -classpath $androidJar -d "$buildDir\classes" $javaFiles
    if ($LASTEXITCODE -ne 0) { throw "$name javac failed" }

    $classFiles = Get-ChildItem -Recurse -Filter "*.class" -Path "$buildDir\classes" | ForEach-Object { $_.FullName }
    & "$bt\d8.bat" --lib $androidJar --output "$buildDir\dex" $classFiles
    if ($LASTEXITCODE -ne 0) { throw "$name d8 failed" }

    # Inject classes.dex into unaligned.apk (zip)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open("$buildDir\unaligned.apk", "Update")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$buildDir\dex\classes.dex", "classes.dex") | Out-Null
    $zip.Dispose()

    & "$bt\zipalign.exe" -f -p 4 "$buildDir\unaligned.apk" "$buildDir\aligned.apk"
    if ($LASTEXITCODE -ne 0) { throw "$name zipalign failed" }

    & "$bt\apksigner.bat" sign --ks $keystore --ks-key-alias kibangou --ks-pass pass:kibangou2026 --key-pass pass:kibangou2026 --out $outApk "$buildDir\aligned.apk"
    if ($LASTEXITCODE -ne 0) { throw "$name apksigner failed" }
}

Build-AndroidApk "KibangouTV-Mobile" "$root\apps\android-mobile" "$downloads\KibangouTV-Mobile.apk"
Build-AndroidApk "KibangouTV-TV" "$root\apps\android-tv" "$downloads\KibangouTV-TV.apk"

Get-ChildItem $downloads | Select-Object Name, Length

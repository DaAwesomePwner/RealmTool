function Write-TemporaryProfileListing([string]$Root, [string]$Path) {
  $byteLimit = 256KB
  $entryLimit = 1000
  $exists = Test-Path -LiteralPath $Root
  $prefix = '{"exists":' + $exists.ToString().ToLowerInvariant() + ',"truncated":false,"entries":['
  $suffix = ']}'
  $bytes = [Text.Encoding]::UTF8.GetByteCount($prefix + $suffix)
  $entries = [Collections.Generic.List[string]]::new()
  $truncated = $false
  if ($exists) {
    # Bound enumeration as well as serialization; one extra entry detects truncation.
    # PowerShell never follows directory links without -FollowSymlink.
    $items = @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Select-Object -First ($entryLimit + 1))
    foreach ($item in $items) {
      $json = $item | Select-Object FullName, Length, Attributes, LastWriteTimeUtc, LinkTarget |
        ConvertTo-Json -Depth 5 -Compress
      $size = [Text.Encoding]::UTF8.GetByteCount($json) + [int]($entries.Count -gt 0)
      if ($entries.Count -ge $entryLimit -or $bytes + $size -gt $byteLimit) {
        $truncated = $true
        break
      }
      $entries.Add($json)
      $bytes += $size
    }
  }
  if ($truncated) { $prefix = $prefix.Replace('"truncated":false', '"truncated":true') }
  [IO.File]::WriteAllText($Path, $prefix + ($entries -join ',') + $suffix, [Text.UTF8Encoding]::new($false))
}

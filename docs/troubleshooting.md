# Troubleshooting

- **No transcription / permission denied:** open **System Settings → Privacy &
  Security** and ensure **Picrophone** has **Microphone** and **Speech
  Recognition**. Toggle `/voice` off/on.
- **"binary/app missing":** the platform package didn't install, or you're in a
  dev checkout without a build. Reinstall (`pi install npm:picrophone`) or run
  `npm run build`.
- **Version mismatch warning:** the binary and extension versions differ.
  Update (`pi update npm:picrophone`) or, in a checkout, rebuild
  (`npm run build`).
- **Logs:** the Swift side writes `/tmp/picrophone.log`; the bridge writes
  `/tmp/picrophone-ext.log`.

## Reporting a bug

We track **feature requests and bug reports in
[GitHub Issues](https://github.com/zenyui/picrophone/issues)**. Search existing
issues first to avoid duplicates. Include:

- your macOS version (`sw_vers`),
- `picrophone version` output,
- the relevant lines from `/tmp/picrophone.log` and `/tmp/picrophone-ext.log`.

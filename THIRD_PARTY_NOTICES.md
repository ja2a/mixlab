# Third-party notices

MixLab itself is released under the MIT license (see `LICENSE`). The installers published on the
Releases page also contain the following third-party software.

## FFmpeg 9.0.2

MixLab uses FFmpeg (`ffmpeg` and `ffprobe` executables) to decode audio files, resample them and
encode MP3 files. FFmpeg is a separate program, shipped unmodified next to MixLab in
`Resources/bin`, and run as an external process. Copyright © the FFmpeg developers,
https://ffmpeg.org.

| Installer | Build | License |
|---|---|---|
| macOS (Apple Silicon and Intel) | static build by Martin Riedl — https://ffmpeg.martin-riedl.de | GNU GPL version 3 or later (configured with `--enable-gpl --enable-version3`) |
| Windows (x64) | static build by BtbN — https://github.com/BtbN/FFmpeg-Builds | GNU LGPL version 2.1 or later |

- FFmpeg source code for this version: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- Build scripts: https://github.com/BtbN/FFmpeg-Builds and https://git.martin-riedl.de/ffmpeg/build-script
- License texts: GPL v3 https://www.gnu.org/licenses/gpl-3.0.html — LGPL v2.1 https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
- Exact download URLs and SHA-256 checksums are listed in `Resources/bin/SOURCE.txt` inside each
  installer and in `scripts/fetch-ffmpeg.mjs` in this repository.

The FFmpeg builds include LAME (MP3 encoder, LGPL) and other libraries listed in their own
documentation. You may replace the bundled executables with your own FFmpeg build: MixLab looks for
FFmpeg in `MIXLAB_FFMPEG_DIR` first.

## Electron and npm dependencies

The application is built with Electron (MIT) and Chromium (BSD-style and other licenses, listed in
`LICENSES.chromium.html` inside the app), React (MIT), Zustand (MIT), dnd-kit (MIT) and Lucide icons
(ISC).

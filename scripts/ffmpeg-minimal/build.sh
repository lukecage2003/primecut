#!/usr/bin/env bash
# Primestone minimal FFmpeg for Windows (x86_64), cross-compiled with MinGW-w64 from pinned sources.
# Usage: scripts/ffmpeg-minimal/build.sh OUT_DIR   (Linux build host with mingw-w64, nasm, cmake, jq)
# Output: OUT_DIR/{bin/ffmpeg.exe,bin/ffprobe.exe,BUILDCONF.txt,SHA256SUMS,RECORDED.json,sources/,licenses/}
# Sources whose sha256 is null are downloaded, hashed and RECORDED (printed + RECORDED.json) so they
# can be pinned in sources.json; pinned ones must match or the build stops.
set -euo pipefail
OUT=$(realpath -m "${1:?OUT_DIR}"); HERE=$(cd "$(dirname "$0")" && pwd); MAN="$HERE/sources.json"
W=$(mktemp -d); P="$W/prefix"; mkdir -p "$OUT/bin" "$OUT/sources" "$OUT/licenses" "$P/lib/pkgconfig" "$P/include"
HOST=x86_64-w64-mingw32; J=$(nproc)
export PKG_CONFIG_LIBDIR="$P/lib/pkgconfig" PKG_CONFIG_PATH="$P/lib/pkgconfig"
echo '{}' > "$OUT/RECORDED.json"
record() { jq --arg n "$1" --arg k "$2" --arg v "$3" '.[$n][$k]=$v' "$OUT/RECORDED.json" > "$W/r" && mv "$W/r" "$OUT/RECORDED.json"; echo "RECORDED $1 $2=$3"; }
fetch() { # name → extracted dir in $W/src/name
  local name=$1 url sha git ref commit f
  url=$(jq -r ".sources[]|select(.name==\"$name\").url // empty" "$MAN"); git=$(jq -r ".sources[]|select(.name==\"$name\").git // empty" "$MAN")
  mkdir -p "$W/src"
  if [ -n "$git" ]; then
    ref=$(jq -r ".sources[]|select(.name==\"$name\").ref" "$MAN"); commit=$(jq -r ".sources[]|select(.name==\"$name\").commit // empty" "$MAN")
    git clone -q --branch "$ref" "$git" "$W/src/$name"
    if [ -n "$commit" ]; then git -C "$W/src/$name" checkout -q "$commit"; else commit=$(git -C "$W/src/$name" rev-parse HEAD); record "$name" commit "$commit"; fi
    tar -C "$W/src" --exclude=.git -czf "$OUT/sources/$name-$commit.tar.gz" "$name"
  else
    f="$OUT/sources/$(basename "$url")"; curl -fsSL --retry 3 -o "$f" "$url"
    sha=$(jq -r ".sources[]|select(.name==\"$name\").sha256 // empty" "$MAN"); got=$(sha256sum "$f" | cut -d' ' -f1)
    if [ -n "$sha" ]; then [ "$sha" = "$got" ] || { echo "SHA-256 différent pour $name : $got ≠ $sha"; exit 1; }; else record "$name" sha256 "$got"; fi
    mkdir -p "$W/src/$name"; tar -xf "$f" -C "$W/src/$name" --strip-components=1
  fi
  for lf in $(jq -r ".sources[]|select(.name==\"$name\").licenseFiles[]" "$MAN"); do
    src=$(find "$W/src/$name" -maxdepth 2 -name "$lf" | head -1); [ -n "$src" ] && cp "$src" "$OUT/licenses/$name-$lf"; done
}
for n in $(jq -r '.sources[].name' "$MAN"); do fetch "$n"; done
S="$W/src"
( cd "$S/zlib" && make -s -f win32/Makefile.gcc PREFIX=$HOST- -j"$J" libz.a && install -D libz.a "$P/lib/libz.a" && install -D -t "$P/include" zlib.h zconf.h \
  && printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\nName: zlib\nDescription: zlib\nVersion: 1.3.1\nLibs: -L${libdir} -lz\nCflags: -I${includedir}\n' "$P" > "$P/lib/pkgconfig/zlib.pc" )
( cd "$S/nv-codec-headers" && make -s PREFIX="$P" install )
( cd "$S/x264" && ./configure --host=$HOST --cross-prefix=$HOST- --prefix="$P" --enable-static --disable-cli --disable-opencl && make -s -j"$J" && make -s install )
( mkdir -p "$S/x265/b" && cd "$S/x265/b" && cmake -G Ninja ../source -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER=$HOST-gcc -DCMAKE_CXX_COMPILER=$HOST-g++ -DCMAKE_RC_COMPILER=$HOST-windres \
  -DCMAKE_INSTALL_PREFIX="$P" -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="-static-libgcc -static-libstdc++" && ninja && ninja install \
  && sed -i 's/^Libs.private:.*/& -lstdc++/' "$P/lib/pkgconfig/x265.pc" )
( cd "$S/libvpx" && CROSS=$HOST- ./configure --target=x86_64-win64-gcc --prefix="$P" --enable-static --disable-shared --disable-examples --disable-tools --disable-docs --disable-unit-tests && make -s -j"$J" && make -s install )
( cd "$S/opus" && ./configure --host=$HOST --prefix="$P" --enable-static --disable-shared --disable-doc --disable-extra-programs && make -s -j"$J" && make -s install )
CONF=(--prefix="$W/ff" --target-os=mingw32 --arch=x86_64 --cross-prefix=$HOST- --pkg-config=pkg-config --pkg-config-flags=--static
  --enable-gpl --enable-version3 --disable-debug --disable-doc --disable-ffplay --disable-autodetect --enable-zlib
  --enable-libx264 --enable-libx265 --enable-libvpx --enable-libopus --enable-ffnvcodec --enable-nvenc --enable-nvdec --enable-cuda --enable-w32threads --enable-schannel
  --extra-cflags="-I$P/include" --extra-ldflags="-L$P/lib -static -static-libgcc -static-libstdc++" --extra-libs="-lstdc++ -lpthread")
( cd "$S/ffmpeg" && ./configure "${CONF[@]}" && make -s -j"$J" && make -s install )
cp "$W/ff/bin/ffmpeg.exe" "$W/ff/bin/ffprobe.exe" "$OUT/bin/"
{ echo "Primestone FFmpeg minimal — étape $(jq -r .stage "$MAN")"; echo "Compilé le $(date -u +%FT%TZ) sur $(uname -sm), $($HOST-gcc --version | head -1)";
  echo; echo "configure ${CONF[*]}"; echo; jq -r '.sources[]|"\(.name) \(.version) — \(.license)"' "$MAN"; } > "$OUT/BUILDCONF.txt"
( cd "$OUT" && sha256sum bin/* sources/* > SHA256SUMS )
cp "$MAN" "$OUT/sources.json"; cp "$0" "$OUT/build.sh"
echo "OK → $OUT"; cat "$OUT/RECORDED.json"

#!/usr/bin/env bash
# Encode a movie file into a multi-bitrate HLS ladder for Eigakan + R2.
#
# Usage:  ./scripts/encode-hls.sh <input-movie> [output-dir]
# Output: <output-dir>/master.m3u8 plus 720p/480p/360p rendition folders.
#
# Upload the whole output folder to your (private) R2 bucket, e.g.:
#   rclone copy ./movie-hls r2:eigakan-movies/movie-hls
# Then, inside the room, enter the folder name (movie-hls) in the
# "R2 HLS folder" field. The worker mints a signed playlist URL for room
# members only and rewrites the playlists so every rendition and segment
# is authorized — a single presigned master.m3u8 link can NOT do that:
# presigning signs one object, and HLS is a tree of playlists + segments.
#
# Rendition bitrates are capped (maxrate) — peak control matters more than
# averages for smooth playback on variable connections.
set -euo pipefail

INPUT="${1:?usage: encode-hls.sh <input-movie> [output-dir]}"
OUT="${2:-$(basename "${INPUT%.*}")-hls}"
mkdir -p "$OUT"

ffmpeg -y -i "$INPUT" \
  -filter_complex "\
[0:v]split=3[v1][v2][v3]; \
[v1]scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720]; \
[v2]scale=w=854:h=480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480]; \
[v3]scale=w=640:h=360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[v360]" \
  -map "[v720]" -c:v:0 libx264 -profile:v:0 high -b:v:0 2800k -maxrate:v:0 3200k -bufsize:v:0 5600k \
  -map "[v480]" -c:v:1 libx264 -profile:v:1 high -b:v:1 1200k -maxrate:v:1 1400k -bufsize:v:1 2400k \
  -map "[v360]" -c:v:2 libx264 -profile:v:2 main -b:v:2 700k  -maxrate:v:2 850k  -bufsize:v:2 1400k \
  -map 0:a -c:a aac -b:a 128k -ac 2 \
  -var_stream_map "v:0,name:720p v:1,name:480p v:2,name:360p a:0,name:audio" \
  -master_pl_name master.m3u8 \
  -f hls \
  -hls_time 6 \
  -hls_playlist_type vod \
  -hls_segment_filename "$OUT/%v/seg_%05d.ts" \
  "$OUT/%v/playlist.m3u8"

echo
echo "Done: $OUT/master.m3u8"
echo "Upload the whole '$OUT' folder to R2, then enter its folder name in the room's R2 HLS field."

#!/bin/sh
# Re-export the icon PNGs/ICO from the SVG sources (needs Google Chrome + Pillow).
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --window-size="$2,$2" --screenshot="$PWD/$3" "file://$PWD/$1" 2>/dev/null; }
shot icon.svg 1200 icon-1200.png          # Shopify app icon (1200x1200)
shot icon-small.svg 64 icon-small-64.png
python3 - <<'PY'
from PIL import Image
big = Image.open("icon-1200.png").convert("RGB")  # no transparency: Shopify wants a full square
big.save("icon-1200.png")
big.save("icon-1200.jpg", quality=92)
small = Image.open("icon-small-64.png").convert("RGBA")
big.resize((512, 512), Image.LANCZOS).save("../public/icon-512.png")
big.resize((180, 180), Image.LANCZOS).save("../public/apple-touch-icon.png")
small.save("../public/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
PY
cp icon-small.svg ../public/favicon.svg
rm icon-small-64.png
echo "exported"

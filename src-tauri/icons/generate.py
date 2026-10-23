"""Reproduce original geometric app icons. Requires Pillow; no remote assets."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent
image = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((40, 40, 984, 984), radius=220, fill="#171d2c")
for y, x in [(340, 390), (512, 660), (684, 490)]:
    draw.rounded_rectangle((240, y - 24, 784, y + 24), radius=24, fill="#a6efcf")
    draw.ellipse((x - 70, y - 70, x + 70, y + 70), fill="#171d2c", outline="#a6efcf", width=28)
for size, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / name)
image.save(root / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
image.save(root / "icon.icns")

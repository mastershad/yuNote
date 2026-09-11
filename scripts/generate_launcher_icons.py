from pathlib import Path
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "branding" / "yunote-icon-source.png"
SIZES = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")
    if source.width != source.height:
        raise ValueError("yuNote launcher source must be square")

    # The generated source contains a uniform presentation margin around the
    # rounded blue tile. Remove only that margin and preserve the artwork.
    trim = round(source.width * 0.06)
    artwork = source.crop((trim, trim, source.width - trim, source.height - trim))

    for density, size in SIZES.items():
        target = ROOT / "android" / "app" / "src" / "main" / "res" / density
        target.mkdir(parents=True, exist_ok=True)
        icon = artwork.resize((size, size), Image.Resampling.LANCZOS)
        icon.save(target / "ic_launcher.png", optimize=True)
        icon.save(target / "ic_launcher_round.png", optimize=True)


if __name__ == "__main__":
    main()

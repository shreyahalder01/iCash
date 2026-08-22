import bz2
import os
import time
import urllib.request
import dlib

DAT_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat"))
BZ2_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat.bz2"))

URLS = [
    "https://raw.githubusercontent.com/davisking/dlib-models/master/shape_predictor_68_face_landmarks.dat.bz2",
    "http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2",
]

def download_file():
    for url in URLS:
        print(f"Attempting download from: {url}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                total_size = int(resp.headers.get("Content-Length", 0))
                print(f"Total size to download: {total_size} bytes ({total_size / (1024*1024):.2f} MB)")
                downloaded = 0
                with open(BZ2_PATH, "wb") as f_out:
                    while True:
                        chunk = resp.read(256 * 1024)
                        if not chunk:
                            break
                        f_out.write(chunk)
                        downloaded += len(chunk)
                        if total_size > 0:
                            percent = (downloaded / total_size) * 100
                            print(f"\rDownloading... {downloaded/(1024*1024):.1f}/{total_size/(1024*1024):.1f} MB ({percent:.1f}%)", end="", flush=True)
                print("\nDownload complete. Decompressing...")

            dec = bz2.BZ2Decompressor()
            with open(BZ2_PATH, "rb") as f_in, open(DAT_PATH, "wb") as f_out:
                while True:
                    chunk = f_in.read(512 * 1024)
                    if not chunk:
                        break
                    decompressed = dec.decompress(chunk)
                    if decompressed:
                        f_out.write(decompressed)

            if os.path.exists(BZ2_PATH):
                os.remove(BZ2_PATH)

            final_size = os.path.getsize(DAT_PATH)
            print(f"Decompressed successfully! File: {DAT_PATH} ({final_size / (1024*1024):.2f} MB)")
            
            # Verify with dlib
            predictor = dlib.shape_predictor(DAT_PATH)
            print(f"SUCCESS: dlib shape predictor verified: {predictor}")
            return True
        except Exception as e:
            print(f"\nFailed with error: {e}. Retrying next URL...")
            time.sleep(2)
    return False

if __name__ == "__main__":
    download_file()

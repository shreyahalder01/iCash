import bz2
import os

bz2_path = os.path.join(os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat.bz2")
dat_path = os.path.join(os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat")

print(f"Decompressing {bz2_path} -> {dat_path}...")
decompressor = bz2.BZ2Decompressor()
with open(bz2_path, "rb") as f_in, open(dat_path, "wb") as f_out:
    while True:
        chunk = f_in.read(1024 * 1024)
        if not chunk:
            break
        try:
            decompressed = decompressor.decompress(chunk)
            if decompressed:
                f_out.write(decompressed)
        except EOFError:
            break

print(f"Decompressed successfully! Output size: {os.path.getsize(dat_path)} bytes")

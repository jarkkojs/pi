import type { CellImageDecoder } from "@earendil-works/pi-tui";
import { loadPhoton } from "./photon.ts";

/**
 * Decode a base64 image to a tightly-packed RGBA buffer of exactly
 * `width × height` pixels, for the OpenTUI surface's cell-art renderer. Returns
 * null if photon is unavailable or the image cannot be decoded. The mime type is
 * ignored — photon detects the format from the image bytes.
 */
export const decodeImageToRgba: CellImageDecoder = async (base64Data, _mimeType, width, height) => {
	const photon = await loadPhoton();
	if (!photon) return null;
	let image: ReturnType<typeof photon.PhotonImage.new_from_base64> | undefined;
	let resized: ReturnType<typeof photon.resize> | undefined;
	try {
		image = photon.PhotonImage.new_from_base64(base64Data);
		resized = photon.resize(image, width, height, photon.SamplingFilter.Triangle);
		return resized.get_raw_pixels();
	} catch {
		return null;
	} finally {
		resized?.free();
		image?.free();
	}
};

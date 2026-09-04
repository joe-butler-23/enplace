import { describe, expect, it } from "vitest";
import { responsiveSampleCover } from "./responsive-sample-cover";

describe("responsiveSampleCover", () => {
  it("preserves the sample path suffix and caller-owned width policy", () => {
    expect(responsiveSampleCover("/samples/soup.webp?revision=1", [224, 672, 1288])).toEqual({
      avifSrcSet: "/samples/soup-224.avif?revision=1 224w, /samples/soup-672.avif?revision=1 672w, /samples/soup-1288.avif?revision=1 1288w",
      webpSrcSet: "/samples/soup-224.webp?revision=1 224w, /samples/soup-672.webp?revision=1 672w, /samples/soup-1288.webp?revision=1 1288w",
    });
  });

  it("leaves non-sample covers outside responsive URL generation", () => {
    expect(responsiveSampleCover("/covers/soup.webp", [224, 672])).toBeNull();
  });
});

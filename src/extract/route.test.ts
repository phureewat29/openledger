import { describe, it, expect } from "vitest";
import { READER, classifyPage, verdictOf, type PageFacts } from "./route.js";

describe("READER", () => {
  it("reads a complete text layer directly, and a partial or missing one by OCR", () => {
    expect(READER).toEqual({ complete: "text-layer", partial: "ocr", none: "ocr" });
  });
});

const text: PageFacts = { chars: 2411, imageCover: 0 };
const scan: PageFacts = { chars: 0, imageCover: 1 };
const blank: PageFacts = { chars: 0, imageCover: 0 };

describe("classifyPage", () => {
  it("trusts a long text layer whatever lies under it", () => {
    expect(classifyPage({ chars: 400, imageCover: 0 })).toBe("text");
    expect(classifyPage({ chars: 400, imageCover: 1 })).toBe("text");
  });

  it("counts a thin text layer over a page-sized image as a scan", () => {
    expect(classifyPage({ chars: 399, imageCover: 0.5 })).toBe("scan");
  });

  it("keeps a short digital layer as text, bare or beside a logo", () => {
    expect(classifyPage({ chars: 129, imageCover: 0 })).toBe("text");
    expect(classifyPage({ chars: 129, imageCover: 0.04 })).toBe("text");
  });

  it("counts an image with no text layer as a scan, however small", () => {
    expect(classifyPage({ chars: 0, imageCover: 0.04 })).toBe("scan");
  });

  it("counts a page with neither text nor image as blank", () => {
    expect(classifyPage(blank)).toBe("blank");
  });
});

describe("verdictOf", () => {
  it("calls an all-text document complete", () => {
    expect(verdictOf([text, text])).toBe("complete");
  });

  it("lets a blank trailer page keep the document complete", () => {
    expect(verdictOf([text, text, blank])).toBe("complete");
  });

  it("lets a short closing page with a logo keep the document complete", () => {
    expect(verdictOf([text, { chars: 60, imageCover: 0.04 }])).toBe("complete");
  });

  it("calls a text document with one scanned page partial", () => {
    expect(verdictOf([text, blank, scan])).toBe("partial");
  });

  it("calls a document with no text page none, however it got there", () => {
    expect(verdictOf([scan, scan])).toBe("none");
    expect(verdictOf([blank])).toBe("none");
    expect(verdictOf([])).toBe("none");
  });
});

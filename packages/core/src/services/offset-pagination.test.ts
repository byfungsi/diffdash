import { describe, expect, it } from "@effect/vitest"
import { paginateByOffset } from "./offset-pagination"

describe("paginateByOffset", () => {
  const items = ["a", "b", "c", "d", "e"] as const

  it("returns a bounded page and the next offset", () => {
    expect(paginateByOffset(items, 1, 2)).toEqual({
      items: ["b", "c"],
      offset: 1,
      limit: 2,
      total: 5,
      hasMore: true,
      nextOffset: 3,
    })
  })

  it("ends pagination on exact-fit and partial final pages", () => {
    expect(paginateByOffset(items, 3, 2)).toMatchObject({
      items: ["d", "e"],
      hasMore: false,
      nextOffset: null,
    })
    expect(paginateByOffset(items, 4, 10)).toMatchObject({
      items: ["e"],
      hasMore: false,
      nextOffset: null,
    })
  })

  it("returns an empty terminal page at and beyond the collection bound", () => {
    expect(paginateByOffset(items, 5, 2)).toMatchObject({
      items: [],
      offset: 5,
      hasMore: false,
      nextOffset: null,
    })
    expect(paginateByOffset(items, 20, 2)).toMatchObject({
      items: [],
      offset: 20,
      hasMore: false,
      nextOffset: null,
    })
  })

  it("rejects invalid page bounds", () => {
    expect(() => paginateByOffset(items, -1, 2)).toThrow(RangeError)
    expect(() => paginateByOffset(items, 0, 0)).toThrow(RangeError)
    expect(() => paginateByOffset(items, 0.5, 2)).toThrow(RangeError)
  })
})

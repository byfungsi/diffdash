import { describe, expect, it } from "vitest"

import { OpenBranchDiffCommand, OpenWorkingTreeCommand } from "@diffdash/protocol/cli-navigation"
import { createNavigationCommandQueue } from "./navigation-command-queue"

describe("createNavigationCommandQueue", () => {
  it("retains pre-renderer commands until a peeked batch is acknowledged", () => {
    const queue = createNavigationCommandQueue()
    const initialCommand = OpenWorkingTreeCommand.make({ localPath: "/repo" })
    const preReadySecondInstanceCommand = OpenBranchDiffCommand.make({
      localPath: "/repo",
      branchName: "main",
    })

    queue.enqueue(initialCommand)
    queue.enqueue(preReadySecondInstanceCommand)

    expect(queue.hasPending()).toBe(true)
    expect(queue.peek()).toEqual([initialCommand, preReadySecondInstanceCommand])
    expect(queue.peek()).toEqual([initialCommand, preReadySecondInstanceCommand])
    queue.acknowledge(2)
    expect(queue.hasPending()).toBe(false)
    expect(queue.peek()).toEqual([])
  })

  it("retains commands arriving after an earlier drain", () => {
    const queue = createNavigationCommandQueue()
    const command = OpenWorkingTreeCommand.make({ localPath: "/later" })

    expect(queue.peek()).toEqual([])
    queue.enqueue(command)

    expect(queue.peek()).toEqual([command])
  })

  it("bounds pending commands and each transactional drain", () => {
    const queue = createNavigationCommandQueue({ maxPending: 3, maxDrain: 2 })
    const first = OpenWorkingTreeCommand.make({ localPath: "/one" })
    const second = OpenWorkingTreeCommand.make({ localPath: "/two" })
    const third = OpenWorkingTreeCommand.make({ localPath: "/three" })

    expect(queue.enqueue(first)).toBe(true)
    expect(queue.enqueue(second)).toBe(true)
    expect(queue.enqueue(third)).toBe(true)
    expect(queue.enqueue(OpenWorkingTreeCommand.make({ localPath: "/four" }))).toBe(false)
    expect(queue.peek()).toEqual([first, second])
    queue.acknowledge(2)
    expect(queue.peek()).toEqual([third])
  })
})

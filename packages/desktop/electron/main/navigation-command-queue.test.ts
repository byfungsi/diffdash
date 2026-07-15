import { describe, expect, it } from "vitest"

import { OpenBranchDiffCommand, OpenWorkingTreeCommand } from "../../src/shared/cli-navigation"
import { createNavigationCommandQueue } from "./navigation-command-queue"

describe("createNavigationCommandQueue", () => {
  it("retains pre-renderer commands in arrival order and drains them once", () => {
    const queue = createNavigationCommandQueue()
    const initialCommand = OpenWorkingTreeCommand.make({ localPath: "/repo" })
    const preReadySecondInstanceCommand = OpenBranchDiffCommand.make({
      localPath: "/repo",
      branchName: "main",
    })

    queue.enqueue(initialCommand)
    queue.enqueue(preReadySecondInstanceCommand)

    expect(queue.hasPending()).toBe(true)
    expect(queue.drain()).toEqual([initialCommand, preReadySecondInstanceCommand])
    expect(queue.hasPending()).toBe(false)
    expect(queue.drain()).toEqual([])
  })

  it("retains commands arriving after an earlier drain", () => {
    const queue = createNavigationCommandQueue()
    const command = OpenWorkingTreeCommand.make({ localPath: "/later" })

    expect(queue.drain()).toEqual([])
    queue.enqueue(command)

    expect(queue.drain()).toEqual([command])
  })
})

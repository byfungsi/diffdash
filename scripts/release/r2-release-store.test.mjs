import assert from "node:assert/strict"
import test from "node:test"

import { R2ReleaseStore } from "./r2-release-store.mjs"

const configuration = {
  bucket: "release-bucket",
  endpoint: "https://account.r2.example.test",
  awsEnvironment: { AWS_ACCESS_KEY_ID: "secret-id", AWS_SECRET_ACCESS_KEY: "secret-key" },
}

test("uses immutable candidate uploads and pointer-specific cache policies", () => {
  const calls = []
  const store = new R2ReleaseStore(configuration, {
    run: (command, args, options) => calls.push({ command, args, options }),
  })
  store.uploadCandidate("v1.2.3", "asset.zip", "/tmp/asset.zip", "abc")
  store.copyCandidateLatestToPointer("v1.2.3")
  store.uploadPointer("stable.json", "/tmp/stable.json")

  assert.match(calls[0].args.join(" "), /public, max-age=31536000, immutable/u)
  assert.match(calls[1].args.join(" "), /public, max-age=60/u)
  assert.match(calls[2].args.join(" "), /no-store/u)
  assert.equal(
    calls.some(({ args }) => args.join(" ").includes("secret-key")),
    false,
  )
})

test("backs up and restores existing pointers in caller-controlled order", () => {
  const executed = []
  const run = []
  const store = new R2ReleaseStore(configuration, {
    execute: (command, args, options) => {
      executed.push({ command, args, options })
      return args.includes("list-objects-v2") ? "1" : ""
    },
    run: (command, args) => run.push({ command, args }),
  })
  const pointer = store.backupPointer("latest.json", "/tmp/previous-latest.json")
  store.restorePointer(pointer)

  assert.equal(pointer.existed, true)
  assert.match(executed[1].args.join(" "), /s3 cp s3:\/\/release-bucket\/latest\.json/u)
  assert.match(run[0].args.join(" "), /public, max-age=60/u)
})

test("removes a newly-created pointer during rollback", () => {
  const calls = []
  const store = new R2ReleaseStore(configuration, {
    run: (command, args) => calls.push({ command, args }),
  })
  store.restorePointer({ name: "stable.json", backupPath: "/tmp/unused", existed: false })
  assert.match(calls[0].args.join(" "), /s3 rm s3:\/\/release-bucket\/stable\.json/u)
})

test("accepts only exact zero and one pointer counts from AWS", () => {
  for (const output of ["", " ", " 1 ", "1\n\n", "2", "01", "1 pointer", "NaN"]) {
    const calls = []
    const store = new R2ReleaseStore(configuration, {
      execute: (command, args) => {
        calls.push({ command, args })
        return output
      },
    })

    assert.throws(
      () => store.backupPointer("stable.json", "/tmp/previous-stable.json"),
      /Could not determine the existing R2 stable\.json pointer/u,
    )
    assert.equal(calls.length, 1)
  }
})

test("recognizes an exact zero count with the AWS trailing newline", () => {
  const executed = []
  const store = new R2ReleaseStore(configuration, {
    execute: (command, args) => {
      executed.push({ command, args })
      return "0\n"
    },
  })

  const pointer = store.backupPointer("stable.json", "/tmp/previous-stable.json")

  assert.deepEqual(pointer, {
    name: "stable.json",
    backupPath: "/tmp/previous-stable.json",
    existed: false,
  })
  assert.equal(executed.length, 1)
})

test("does not classify an ambiguous pointer count as absent during rollback setup", () => {
  const executed = []
  const mutations = []
  const store = new R2ReleaseStore(configuration, {
    execute: (command, args) => {
      executed.push({ command, args })
      return "\n"
    },
    run: (command, args) => mutations.push({ command, args }),
  })

  assert.throws(
    () => store.backupPointer("latest.json", "/tmp/previous-latest.json"),
    /Could not determine the existing R2 latest\.json pointer/u,
  )
  assert.equal(executed.length, 1)
  assert.deepEqual(mutations, [])
})

test("lists release prefixes and deletes only the prefix selected by retention policy", () => {
  const calls = []
  const store = new R2ReleaseStore(configuration, {
    execute: () => JSON.stringify(["releases/v1.2.3/", "releases/v1.2.2/"]),
    run: (command, args) => calls.push({ command, args }),
  })
  assert.deepEqual(store.listReleasePrefixes(), ["releases/v1.2.3/", "releases/v1.2.2/"])
  store.deleteReleasePrefix("releases/v1.2.2/")
  assert.match(
    calls[0].args.join(" "),
    /s3 rm s3:\/\/release-bucket\/releases\/v1\.2\.2\/ --recursive/u,
  )
})

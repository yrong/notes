// src/filter.ts
var RemoveDrafts = () => ({
  name: "RemoveDrafts",
  shouldPublish(_ctx, [_tree, vfile]) {
    const frontmatter = vfile.data?.frontmatter;
    const draftFlag = frontmatter?.draft === true || frontmatter?.draft === "true";
    const publishFlag = frontmatter?.publish === false || frontmatter?.publish === "false";
    return !draftFlag && !publishFlag;
  }
});

export { RemoveDrafts };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map
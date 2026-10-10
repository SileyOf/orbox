#!/bin/sh
# 生成升级包：只包含两个版本之间变化的文件，外加一个在服务器上执行的 upgrade.sh。
# 用法：scripts/make-upgrade.sh <起始版本标签> [额外要带上的文件...]
#   例：scripts/make-upgrade.sh v0.1.0
# 目标版本取当前 package.json 里的版本号，对应的提交是 HEAD（请先提交并打好标签）。
set -eu
cd "$(dirname "$0")/.."

FROM_TAG=${1:?用法: scripts/make-upgrade.sh <起始版本标签> [额外文件...]}
shift
FROM=${FROM_TAG#v}
TO=$(node -p "require('./package.json').version")
NAME="orbox-upgrade-$FROM-to-$TO"
OUT="release/$NAME"

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交的改动，请先提交" >&2
  exit 1
fi

rm -rf "$OUT" "$OUT.tar.gz"
mkdir -p "$OUT/files"

# 新增和修改的文件（连同手动指定的额外文件），以及被删除的文件
{ git diff --name-only --diff-filter=ACMR "$FROM_TAG" HEAD; for f in "$@"; do echo "$f"; done; } | sort -u > "$OUT/changed.txt"
git diff --name-only --diff-filter=D "$FROM_TAG" HEAD > "$OUT/deleted.txt"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$OUT/files/$(dirname "$f")"
  git show "HEAD:$f" > "$OUT/files/$f"
done < "$OUT/changed.txt"

# 本次版本的更新说明：CHANGELOG 里目标版本那一节
awk -v v="## $TO" '$0==v{p=1;print;next} /^## /{p=0} p' CHANGELOG.md > "$OUT/NOTES.md"

sed -e "s/@FROM@/$FROM/g" -e "s/@TO@/$TO/g" scripts/upgrade.sh.in > "$OUT/upgrade.sh"
chmod +x "$OUT/upgrade.sh"

tar -czf "$OUT.tar.gz" -C release "$NAME"
rm -rf "$OUT"
echo "已生成 $OUT.tar.gz"
tar -tzf "$OUT.tar.gz"

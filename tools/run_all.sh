#!/bin/bash
# 跑全部验证脚本。
#
# 每个测试都起一个独立的 headless Chrome。连着跑十几个，页面加载速度会
# 随机器负载波动，于是出现"单跑能过、连跑随机挂一两个"的现象——挂的是
# 哪个每次都不一样，说明问题不在被测代码。
#
# 所以做了两件事：脚本之间隔两秒让上一个 Chrome 退干净；失败的测试自动
# 重试一次。重试是 CI 里对付这类抖动的常规手段，比把每个断言都改成
# "轮询等条件"省事得多，也不会掩盖真正的失败——真有问题的话两次都过不了。
#
# 用法：bash tools/run_all.sh

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

TESTS=(
  verify_player verify_movement verify_combat verify_elements
  verify_inventory verify_collision verify_quest verify_platform
  verify_swim verify_climb verify_dodge verify_save verify_chest
  verify_sidequest verify_shock verify_gust verify_audio
  verify_weapon_beast verify_weapon_flow verify_cooking
)

pass=0
fail=0
failed_names=()

for t in "${TESTS[@]}"; do
  printf '%-20s ' "$t"
  out=$(node "tools/$t.mjs" 2>&1 | tail -1)

  if echo "$out" | grep -q '^✅'; then
    echo "$out"
    pass=$((pass + 1))
  else
    # 挂了一次：等久一点再试一次，两次都挂才算真失败
    printf '%s\n' "$out"
    printf '%-20s ' "$t(重试)"
    sleep 6
    out=$(node "tools/$t.mjs" 2>&1 | tail -1)
    echo "$out"
    if echo "$out" | grep -q '^✅'; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      failed_names+=("$t")
    fi
  fi
  sleep 2
done

echo ''
echo "通过 $pass / $((pass + fail))"
if [ "$fail" -gt 0 ]; then
  echo "失败：${failed_names[*]}"
  exit 1
fi
echo '全部通过 ✅'

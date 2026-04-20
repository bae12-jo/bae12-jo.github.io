---
title: "분산 학습 - Part 2: p6-b200 노드가 계속 재부팅되는 이유"
author: Bailey Sohyeon Cho
layout: post
lang: ko
---

# AWS ParallelCluster에서 p6-b200 컴퓨트 노드가 계속 재부팅되는 이유

> **시리즈**: AWS ParallelCluster로 분산 학습 환경 구축하기
>
> [← Part 1: ParallelCluster 동작 원리](/pages/pcluster-series-1-internals-ko/) | [Part 3: 커스텀 AMI 만들기 →](/pages/pcluster-series-3-custom-ami-ko/)

p6-b200.48xlarge 클러스터를 프로비저닝하고, 타임아웃을 두 배로 늘리고, 헬스 체크를 비활성화해도 노드가 계속 죽습니다. 어떤 노드는 정확히 68초에 재부팅됩니다. 어떤 노드는 7분을 버티다 사라집니다. 몇몇은 완전히 부팅된 후 루프를 돌며 재시작됩니다. 뻔한 해결책들이 통하지 않아서 이 글을 읽고 계신 겁니다.

이 글에서는 프로덕션 p6-b200 클러스터를 디버깅하며 발견한 네 가지 근본 원인을 다룹니다. 각각 다른 오류 메시지, 다른 타이밍, 다른 위장 방식으로 나타납니다.

---

## 원인 1: 노드가 ~68초에 종료 — `ib_umad` 없음

**증상**: 노드가 부팅되고, 커널이 로드되고, systemd가 서비스를 시작합니다. 정확히 68초에 인스턴스가 꺼집니다. CloudFormation이 `nvidia_config` 중 실패를 보고합니다. 유용한 로그가 없습니다.

**시도했지만 효과 없었던 것들**:
- `ComputeNodeBootstrapTimeout`을 3600s로 늘림 — 여전히 68초에 죽음
- `systemctl disable nvidia-fabricmanager` — 효과 없음
- `nvidia-smi` standalone 실행 — 완벽하게 동작

**실제 원인**: cinc의 `fabric_manager :configure` 단계에서 `nvidia-fabricmanager`가 시작됩니다. 이 서비스는 내부적으로 `/sys/class/infiniband`를 60초 동안 폴링하며 IB 디바이스를 찾습니다. `ib_umad` 커널 모듈 없이는 디바이스가 나타나지 않습니다. 60초 후 fabricmanager는 "Pre-NVL5 시스템"으로 오감지하고 — GB100 GPU가 장착된 p6-b200에서 이는 커널 패닉을 유발합니다.

```
[   68.245821] nvidia-fabricmanager-start.sh: 60초 내 /sys/class/infiniband에서 디바이스를 찾을 수 없음
[   68.452104] Pre-NVL5 시스템 감지, NVSwitch fabric 지원 없이 초기화
[   68.623018] NVRM: _knvlinkCheckFabricCliqueId: GPU 0가 fabric clique Id 가져오기 실패: 0x55
[   68.901234] 커널 패닉 - 동기화 안 됨: GPU fabric 초기화 실패
```

68초라는 타이밍은 타임아웃처럼 보이지만, 실제로는 fabricmanager 사전 검사 임계값(60s 폴링 + ~8s 오버헤드)입니다.

> ##### TIP
>
> `ib_umad`는 **cinc 시작 전에 로드**되어야 합니다. OnNodeStart에서 `modprobe ib_umad`를 실행하면 너무 늦습니다 — cinc가 이미 fabric_manager를 시작했습니다. 모듈은 AMI에 `/etc/modules`를 통해 베이크되어야 합니다.
{: .block-tip }

**해결책**:

```bash
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
modprobe ib_umad
echo "ib_umad" >> /etc/modules   # ← 재부팅 후에도 유지
```

**검증**: `lsmod | grep ib_umad`가 부팅 시 모듈이 로드됐음을 보여야 합니다.

---

## 원인 2: 노드가 ~7분에 재부팅 — `reboot-required` 함정

**증상**: 노드가 시작되고, cfn-signal이 성공을 보고하고, Slurm이 노드를 IDLE로 표시합니다. 작업을 제출합니다. 7분 후 — 사라집니다. 작업 로그에 오류 없음. 노드가 다시 올라와서 또 부팅됩니다.

**시도했지만 효과 없었던 것들**:
- `unattended-upgrades` 마스킹 — 재부팅 방지 안 됨
- `needrestart` 제거 — 도움 안 됨
- OnNodeConfigured 훅에서 reboot 플래그 제거 — 너무 늦게 실행됨

**실제 원인**: cinc의 init 단계에서 `linux-modules-extra-$(uname -r)` 포함 패키지를 설치합니다. 우리 클러스터에서는 커널 마이너 버전이 `6.8.0-1050-aws`에서 `6.8.0-1052-aws`로 업그레이드됐습니다. 이때 apt의 post-install 훅이 `/var/run/reboot-required`를 생성합니다. 파일은 cinc init 중에 생성되지만, cinc finalize는 **cfn-signal 이후에 실행**됩니다. finalize에서 cinc는 이 파일을 명시적으로 확인하고 `reboot`을 호출합니다. 노드가 UP 상태로 작업을 실행하는 시점에 finalize가 아직 실행되지 않은 것입니다.

```
cinc finalize 로그:
  [INFO] 실행 중: package[linux-modules-extra-6.8.0-1052-aws]   ← reboot 플래그 트리거
  [INFO] /var/run/reboot-required: 존재
  [INFO] 실행 중: /sbin/reboot   ← cfn-signal 7분 후
```

> ##### WARNING
>
> `needrestart` 제거와 `unattended-upgrades` 마스킹만으로는 부족합니다. **cinc 자체가** 패키지를 설치하고 reboot 플래그를 생성합니다 — dpkg post-invoke 훅으로 설치 직후 파일을 삭제하는 것이 유일한 확실한 해결책입니다.
{: .block-warning }

**해결책**:

```bash
cat > /etc/apt/apt.conf.d/99-no-reboot-required <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
```

이 훅은 모든 패키지 설치 후(cinc 중 포함) 실행되어 reboot 마커를 즉시 삭제합니다.

**7분이라는 타이밍**: cfn-signal은 slurmd가 등록될 때 발생합니다. cinc finalize는 그 후, 일반적으로 p6-b200에서 FSx 마운트와 추가 설정 단계로 인해 5~7분 후에 실행됩니다.

---

## 원인 3: cinc `:start`가 항상 실패 — AMI에서 Fabricmanager가 masked 상태

**증상**: cinc 중 노드 실패, cfn-signal 이전. cinc.log 오류: `service[nvidia-fabricmanager] (aws-parallelcluster-entrypoints::nvidia_config line 45) had an error: expected '0' but got '1'`. 타이밍은 68초가 아닌 ~3분(cinc 타임아웃).

**시도했지만 효과 없었던 것들**:
- `systemctl disable`과 `systemctl mask`가 같다고 생각 — 다릅니다
- OnNodeConfigured에서 서비스 unmask — 너무 늦음, cinc가 이미 실패

**실제 원인**: `systemctl mask`로 서비스를 마스킹하면 유닛 파일이 `/dev/null`을 가리키는 심링크가 생성됩니다. cinc의 `fabric_manager :configure` 레시피가 `systemctl start`를 실행하면, 마스킹된 서비스에서는 항상 종료 코드 1을 반환합니다. cinc는 오류를 확인하고 레시피를 FATAL로 표시하여 노드 부트스트랩이 실패합니다.

> ##### DANGER
>
> AMI에서 `systemctl mask nvidia-fabricmanager`하면 = **cinc에서 항상 FATAL**. 우회 방법이 없습니다 — AMI 베이크 시점에 서비스는 반드시 `enabled` 또는 `disabled` 상태여야 합니다.
{: .block-danger }

상태별 동작:

| systemctl 상태 | cinc `start` 동작 |
|---|---|
| `enabled` | 이미 실행 중이면 → no-op ✅ |
| `disabled` | 서비스 시작 시도 → 성공 또는 실패 |
| `masked` | **항상 오류 코드 1 반환 — 항상 FATAL** ❌ |

**해결책**:

```bash
# ✅ 올바른 방법
systemctl enable nvidia-fabricmanager

# ❌ AMI에서 절대 하지 말 것
systemctl mask nvidia-fabricmanager
```

---

## 원인 4: Conf 해시 재부팅 루프 — `cfn-hup` 함정

**증상**: 클러스터가 안정적이고 작업이 실행 중입니다. CloudFormation 스택을 업데이트합니다. 갑자기 노드들이 하나씩 DOWN이 됩니다. slurmctld 로그: `Node compute-node-1: appears to have a different slurm.conf hash`. 노드가 IDLE로 복구되다가 즉시 다시 DOWN이 됩니다. 루프가 몇 분마다 반복됩니다.

**시도했지만 효과 없었던 것들**:
- slurmctld 수동 재시작 — 루프 계속
- 모든 노드에서 slurm.conf 업데이트 — 해시가 계속 드리프트
- `SlurmdTimeout` 증가 — DOWN 상태 멈추지 않음

**실제 원인**: CloudFormation 스택을 업데이트하면, HeadNode에서 실행 중인 cfn-hup이 변경을 감지하고 slurmctld를 재시작합니다. 각 재시작은 slurm.conf를 재생성하고 새 해시를 계산합니다. 이를 ComputeNode에 브로드캐스트합니다. 노드의 해시가 일치하지 않으면 slurmctld가 DOWN으로 표시합니다. clustermgtd가 DOWN을 감지하고 `/sbin/reboot`을 트리거합니다. 노드가 재부팅되고 새 conf를 동기화하고 IDLE이 되고 하트비트를 보냅니다 — 하지만 cfn-hup이 다시 실행되면 사이클이 반복됩니다.

```
T+0s    CloudFormation 스택 업데이트
T+5s    cfn-hup 실행 → slurmctld 재시작
T+10s   slurmctld가 slurm.conf 재생성, 새 해시 = HASH_V2
T+20s   compute-node-1은 여전히 HASH_V1 → 불일치 보고
T+25s   slurmctld가 compute-node-1을 DOWN으로 표시
T+30s   clustermgtd가 DOWN 감지 → /sbin/reboot
T+90s   노드 재부팅, HASH_V2 획득, IDLE 상태
T+95s   cfn-hup 다시 실행 → 사이클 반복
```

> ##### WARNING
>
> 이 루프는 무한정 실행되며 장시간 실행 중인 작업을 조용히 중단시킵니다. 2시간 동안 실행 중인 작업이 CloudFormation 스택을 건드리는 순간 실행 도중에 종료됩니다.
{: .block-warning }

**해결책** — pcluster 클러스터 설정에 추가:

```yaml
CustomSlurmSettings:
  - "DebugFlags=NO_CONF_HASH"
```

conf 해시 불일치 검사를 억제합니다. 설정이 일관성 있다고 신뢰하는 관리형 CloudFormation 환경에서는 안전합니다.

---

## Standalone EC2 테스트가 이 문제들을 잡지 못하는 이유

| 측면 | Standalone EC2 | pcluster 컴퓨트 노드 |
|---|---|---|
| cinc | 실행되지 않음 | 자동으로 실행됨 |
| Reboot 검사 | 직접 제어 | cinc finalize가 자동 확인 |
| 서비스 상태 | 직접 관리 | cinc가 `enabled` 강제; masked = 실패 |
| Conf 해시 | slurmd 없음 | slurmctld/slurmd가 모든 하트비트에서 비교 |
| cfn-hup | 없음 | 스택 감시, 서비스 재시작 |

이 네 가지 원인 모두 ParallelCluster의 내부 오케스트레이션이 있어야 트리거됩니다. Standalone 인스턴스에서는 절대 발생하지 않습니다. 실제 클러스터에서 테스트해야 하는 이유입니다.

---

## 진단 플로우차트

**노드가 ~68초에 종료되나요?**
- `dmesg`에서 "Detected Pre-NVL5" 또는 "kbifCacheVFInfo" 패닉 확인
- **→ 원인 1**: `ib_umad` 없음. AMI에 베이크하세요.

**cfn-signal 성공 후 ~5~7분에 노드가 종료되나요?**
- `/var/log/parallelcluster/cinc.log`에서 "Executing: /sbin/reboot" 확인
- **→ 원인 2**: `reboot-required` 함정. AMI에 dpkg 훅 추가.

**cinc 중 cfn-signal 이전에 노드 실패 (~3분)?**
- cinc.log에서 `service[nvidia-fabricmanager] had an error: expected '0' but got '1'` 확인
- **→ 원인 3**: fabricmanager가 masked 상태. `mask` 대신 `enable` 사용.

**노드가 UP → DOWN → IDLE → UP 반복되나요?**
- slurmctld 로그에서 "appears to have a different slurm.conf hash" 확인
- **→ 원인 4**: conf 해시 루프. `DebugFlags=NO_CONF_HASH` 추가.

---

> **시리즈**: AWS ParallelCluster로 분산 학습 환경 구축하기
>
> [← Part 1: ParallelCluster 동작 원리](/pages/pcluster-series-1-internals-ko/) | **Part 2: p6-b200 노드가 계속 재부팅되는 이유** | [Part 3: 커스텀 AMI 만들기 →](/pages/pcluster-series-3-custom-ami-ko/)
{: .block-tip }

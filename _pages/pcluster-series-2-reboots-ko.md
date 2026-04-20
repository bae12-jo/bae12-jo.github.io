---
title: "Part 3: p6-b200 노드가 계속 재부팅되는 이유"
author: Bailey Sohyeon Cho
layout: post
lang: ko
lang_peer: /pages/pcluster-series-2-reboots/
---

# AWS ParallelCluster에서 p6-b200 노드가 계속 재부팅되는 이유

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 2: ParallelCluster 내부 동작 원리](/pages/pcluster-series-1-internals-ko/) | [Part 4: 커스텀 AMI 만들기 →](/pages/pcluster-series-3-custom-ami-ko/)

## 클러스터가 뜨기도 전에 롤백되나요?

그렇습니다. p6-b200 같은 GPU 인스턴스에서는 이 문제를 모르면 계속 당합니다.

`pcluster create-cluster`를 실행하면 CloudFormation이 스택을 시작하고 모든 리소스가 성공 신호를 보내기를 기다립니다. 컴퓨트 노드는 cloud-init을 돌리고, cinc를 실행하고, 드라이버를 설치하고, `ComputeNodeBootstrapTimeout` 안에 `cfn-signal`을 보내야 합니다. p6-b200에서 이 부트스트랩만 15~25분이 걸립니다. 기본 타임아웃은 30분입니다. 제때 신호를 못 보내면 CloudFormation이 실패로 표시하고 스택 전체를 롤백합니다.

롤백이 되면 HeadNode, FSx 연결, 네트워킹이 전부 사라집니다. 처음부터 다시 만들어야 합니다.

두 가지 설정이 이 상황을 바꿔줍니다:

```yaml
# 클러스터 설정
DevSettings:
  Timeouts:
    ComputeNodeBootstrapTimeout: 3600
```

```bash
# 생성 시
pcluster create-cluster \
  --cluster-configuration config.yaml \
  --rollback-on-failure false
```

타임아웃 증가는 단순합니다. 부트스트랩이 끝날 시간을 충분히 주는 것입니다. `--rollback-on-failure false`가 더 중요합니다. 노드가 실패해도 스택을 살려두기 때문에 SSM으로 접속해서 무슨 일이 있었는지 실제로 볼 수 있습니다. 이 옵션 없이는 실패할 때마다 클러스터가 날아가고 눈 가리고 디버깅해야 합니다.

> ##### DANGER
>
> Capacity Block 인스턴스에서 롤백은 특히 치명적입니다. 스택이 해체되면 CB 슬롯이 반환되고 다시 확보하지 못할 수 있습니다. p6-b200 설정을 반복 테스트할 때는 반드시 `--rollback-on-failure false`를 사용하세요.
{: .block-danger }

노드가 실패했을 때 클러스터를 삭제하고 재생성하지 마세요. `pcluster update-cluster`로 설정을 밀거나, SSM으로 문제 노드에 직접 접속해서 고치세요. 재생성하면 HeadNode 부트스트랩도 다시 거쳐야 합니다. 10~15분이 또 날아갑니다.

---

p6-b200.48xlarge 클러스터를 프로비저닝하고, 타임아웃을 두 배로 늘리고, 헬스 체크를 비활성화해도 노드가 계속 죽습니다. 어떤 노드는 정확히 68초에 재부팅됩니다. 어떤 노드는 7분을 버티다 사라집니다. 몇몇은 완전히 부팅된 후에도 루프를 돌며 재시작합니다. 뻔한 해결책들이 통하지 않아서 이 글을 읽고 계신 겁니다.

근본 원인이 네 가지 있습니다. 각각 다른 시점에, 다른 오류 메시지로, 다른 것처럼 위장합니다.

---

## 원인 1: ~68초에 종료 — `ib_umad` 없음

**증상**: 노드가 부팅되고, 커널이 로드되고, systemd가 서비스를 시작합니다. 68초에 인스턴스가 꺼집니다. CloudFormation이 `nvidia_config` 중 실패를 보고합니다. 노드에 유용한 로그가 없습니다.

`ComputeNodeBootstrapTimeout`을 3600s로 늘려도 여전히 68초에 죽습니다. `systemctl disable nvidia-fabricmanager`도 효과 없습니다. Standalone에서 `nvidia-smi`는 완벽하게 동작합니다.

**실제 원인**: cinc의 `fabric_manager :configure` 단계에서 `nvidia-fabricmanager`가 시작됩니다. 이 서비스는 내부적으로 `/sys/class/infiniband`를 60초 동안 폴링하며 IB 디바이스를 찾습니다. `ib_umad` 커널 모듈 없이는 디바이스가 나타나지 않습니다. 60초 후 fabricmanager는 "Pre-NVL5 시스템"으로 오감지하고, GB100 GPU가 장착된 p6-b200에서 이는 커널 패닉을 유발합니다.

```
[   68.245821] /sys/class/infiniband에서 60초 내 디바이스 없음
[   68.452104] Pre-NVL5 시스템 감지, NVSwitch fabric 지원 없이 초기화
[   68.623018] NVRM: GPU 0 fabric clique Id 가져오기 실패
[   68.901234] 커널 패닉: GPU fabric 초기화 실패
```

68초라는 타이밍은 타임아웃처럼 보이지만, fabricmanager 내부 사전 검사 임계값입니다 (60s 폴링 + ~8s 오버헤드).

`ib_umad`는 cinc 시작 *전에* 로드되어야 합니다. OnNodeStart에서 `modprobe ib_umad`를 실행하면 너무 늦습니다 — cinc가 이미 fabricmanager를 시작한 후입니다. `/etc/modules`에 넣어서 부팅 시 자동으로 로드되게 해야 합니다.

> ##### TIP
>
> 수정은 스크립트가 아니라 AMI에 해야 합니다. 훅 스크립트로 하는 수정은 cinc가 이미 실패한 후에 실행됩니다.
{: .block-tip }

```bash
apt install -y linux-modules-extra-$(uname -r) infiniband-diags ibutils
modprobe ib_umad
echo "ib_umad" >> /etc/modules
```

---

## 원인 2: cfn-signal 성공 후 ~7분에 재부팅

**증상**: 노드가 시작되고, cfn-signal이 성공을 보고하고, Slurm이 IDLE로 표시합니다. 작업을 제출합니다. 7분 후 사라집니다. 작업 로그에 오류 없음. 노드가 다시 올라와서 또 부팅됩니다.

`unattended-upgrades` 마스킹도, `needrestart` 제거도, OnNodeConfigured에서 reboot 플래그 제거도 효과 없습니다.

**실제 원인**: cinc init 단계에서 패키지를 설치합니다. 우리 클러스터에서는 `linux-modules-extra-$(uname -r)` 설치가 커널 마이너 버전을 `6.8.0-1050-aws`에서 `6.8.0-1052-aws`로 업그레이드했습니다. 이때 apt post-install 훅이 `/var/run/reboot-required`를 만들었습니다. 이 파일은 cinc init 중에 생성되지만, cinc finalize는 cfn-signal *이후에* 실행됩니다. finalize에서 cinc가 이 파일을 확인하고 `reboot`을 호출합니다. 노드가 IDLE 상태로 작업을 실행하는 시점에 finalize가 아직 실행되지 않은 것입니다 — 5~7분 후에 실행됩니다.

```
cinc finalize:
  [INFO] linux-modules-extra-6.8.0-1052-aws 설치 → reboot 플래그 생성
  [INFO] /var/run/reboot-required: 존재
  [INFO] /sbin/reboot 실행  ← cfn-signal 7분 후
```

> ##### WARNING
>
> `needrestart` 제거와 `unattended-upgrades` 마스킹은 이 문제에 효과 없습니다. cinc 자체가 패키지를 설치하고 플래그를 만듭니다. 유일한 해결책은 dpkg post-invoke 훅으로 패키지 설치 직후 파일을 삭제하는 것입니다.
{: .block-warning }

```bash
cat > /etc/apt/apt.conf.d/99-no-reboot-required <<'EOF'
DPkg::Post-Invoke { "rm -f /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null || true"; };
EOF
```

모든 패키지 설치 후 — cinc가 트리거하는 것도 포함해서 — 실행되어 플래그를 즉시 삭제합니다.

---

## 원인 3: cinc가 cfn-signal 전에 실패 — AMI에서 fabricmanager masked

**증상**: 노드가 cinc 중 약 3분에 실패합니다. cfn-signal이 발생하지 않습니다. cinc 로그: `service[nvidia-fabricmanager] had an error: expected '0' but got '1'`.

`systemctl disable`과 `systemctl mask`가 같다고 생각했습니다. 다릅니다. OnNodeConfigured에서 언마스킹을 시도했지만 cinc가 이미 실패했습니다.

**실제 원인**: `systemctl mask`는 유닛 파일을 `/dev/null`로 가리키는 심링크를 만듭니다. cinc의 `fabric_manager :configure`가 `systemctl start`를 실행하면, 마스킹된 서비스는 항상 exit code 1을 반환합니다. cinc는 이를 FATAL로 처리하고 부트스트랩이 실패합니다.

| 상태 | cinc `start` 동작 |
|---|---|
| `enabled` | 이미 실행 중이면 no-op |
| `disabled` | 시작 시도 |
| `masked` | 항상 exit code 1 반환 |

> ##### DANGER
>
> 우회 방법이 없습니다. AMI 베이크 시점에 서비스가 masked 상태면 모든 부트스트랩이 실패합니다.
{: .block-danger }

```bash
# 올바른 방법
systemctl enable nvidia-fabricmanager

# AMI에서 절대 하지 말 것
systemctl mask nvidia-fabricmanager
```

---

## 원인 4: Conf 해시 재부팅 루프 — cfn-hup

**증상**: 클러스터가 안정적이고 작업이 실행 중입니다. CloudFormation 스택을 업데이트합니다. 노드들이 하나씩 DOWN이 됩니다. slurmctld 로그: `appears to have a different slurm.conf hash`. 노드가 IDLE로 복구되다가 몇 분 후 다시 DOWN이 됩니다. 루프가 멈추지 않습니다.

slurmctld 수동 재시작, 모든 노드에서 slurm.conf 업데이트 — 해시가 계속 드리프트합니다.

**실제 원인**: CF 스택을 업데이트하면 HeadNode의 cfn-hup이 변경을 감지하고 slurmctld를 재시작합니다. 재시작마다 slurm.conf가 재생성되고 새 해시가 만들어집니다. 컴퓨트 노드는 이전 해시를 가지고 있어 DOWN으로 표시됩니다. clustermgtd가 DOWN을 감지하고 재부팅합니다. 노드가 재부팅되어 새 해시를 받고 IDLE이 됩니다 — 그런데 cfn-hup이 다시 실행됩니다.

```
T+0s    CF 스택 업데이트
T+5s    cfn-hup → slurmctld 재시작
T+10s   새 conf 해시 HASH_V2
T+20s   컴퓨트 노드 여전히 HASH_V1 → 불일치
T+25s   slurmctld: node DOWN
T+30s   clustermgtd → /sbin/reboot
T+90s   재부팅, HASH_V2, IDLE
T+95s   cfn-hup 다시 실행 → 반복
```

> ##### WARNING
>
> 이 루프는 무한정 실행됩니다. 작업이 실행 중인 상태에서 스택을 업데이트하면 해당 작업이 조용히 종료됩니다.
{: .block-warning }

```yaml
CustomSlurmSettings:
  - "DebugFlags=NO_CONF_HASH"
```

---

## Standalone 테스트가 이 문제를 잡지 못하는 이유

이 네 가지 원인은 모두 ParallelCluster의 오케스트레이션이 있어야 트리거됩니다. Standalone 인스턴스에는 cinc도, reboot 플래그 검사도, cfn-hup도, clustermgtd도 없습니다. Standalone에서 통과하고 클러스터에서 실패한다면, 그 차이가 cinc 단계에 있습니다.

---

## 빠른 진단

**~68초에 종료?** → `dmesg | grep -i "Pre-NVL5\|kbifCacheVFInfo"` — 있으면 `ib_umad`가 cinc 전에 로드되지 않았습니다. AMI의 `/etc/modules`에 추가하세요.

**cfn-signal 성공 후 5~7분에 재부팅?** → `cinc.log | grep reboot` — cinc finalize가 reboot을 호출하면 `reboot-required` 플래그 문제입니다. AMI에 dpkg 훅을 추가하세요.

**~3분에 cinc 실패, cfn-signal 없음?** → cinc.log에서 `expected '0' but got '1'` — fabricmanager가 masked입니다. AMI에서 `enable`로 바꾸세요.

**스택 업데이트 후 노드가 UP→DOWN 반복?** → slurmctld.log에서 `different slurm.conf hash` — `DebugFlags=NO_CONF_HASH`를 추가하세요.

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 2: ParallelCluster 내부 동작 원리](/pages/pcluster-series-1-internals-ko/) | 현재: **Part 3: p6-b200 노드 재부팅 원인** | [Part 4: 커스텀 AMI 만들기 →](/pages/pcluster-series-3-custom-ami-ko/)
{: .block-tip }

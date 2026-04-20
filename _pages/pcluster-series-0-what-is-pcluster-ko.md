---
title: "분산 학습 - Part 1: AWS가 만들었지만 당신이 실행한다"
author: Bailey Sohyeon Cho
layout: post
lang: ko
lang_peer: /pages/pcluster-series-0-what-is-pcluster-en/
---

# AWS가 만들었지만 당신이 실행한다: ParallelCluster는 어떤 서비스인가

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> **1/4편** — [Part 2: ParallelCluster 내부 동작 원리 →](/pages/pcluster-series-1-internals-ko/)

ParallelCluster를 EKS나 SageMaker 같은 매니지드 서비스로 생각하는 사람이 많습니다. AWS가 컨트롤 플레인을 운영하고 사용자는 API로 요청만 보내는 구조로요. 아닙니다.

ParallelCluster는 Python CLI입니다. 직접 설치하고, 실행하면, 여러분의 AWS 계정에 CloudFormation 스택, EC2, FSx, VPC를 직접 만들어냅니다. 요청을 받는 "ParallelCluster 서비스"가 없습니다. 로직은 명령어를 입력한 곳에서 돌아갑니다.

```bash
pip install aws-parallelcluster==3.15.0
pcluster create-cluster --cluster-configuration config.yaml
```

이게 전부입니다.

---

## 실제로 어떤 의미냐면

EKS나 SageMaker는 AWS가 컨트롤 플레인을 소유하고 운영합니다. 사용자는 AWS API를 호출하고, 업그레이드 시점도 AWS가 결정합니다.

ParallelCluster는 컨트롤 플레인이 없습니다. CLI 자체가 제품입니다. 그래서 대부분의 AWS 서비스에서는 불가능한 것이 가능합니다 — 버전을 정확히 고정하고, 직접 결정하기 전까지 그 상태를 유지할 수 있습니다. 반대로 AWS가 보안 패치나 새 인스턴스 타입 지원을 자동으로 밀어주지도 않습니다. 이 트레이드오프는 처음부터 알고 들어가는 게 낫습니다.

소스 코드는 전부 공개되어 있습니다: [github.com/aws/aws-parallelcluster](https://github.com/aws/aws-parallelcluster). GPU 노드를 설정하는 Chef 쿡북, 노드 스케일링을 관리하는 데몬, 부트스트랩 스크립트 — 전부 읽을 수 있습니다. 무언가 깨지면 코드를 봅니다. 어떤 문서보다 유용했습니다.

---

## AWS가 공식 지원 안 하는 리전에서도 동작한다

CLI가 CloudFormation과 EC2를 직접 호출하는 구조라서, 기술적으로 AWS 공식 지원 리전 목록에 묶이지 않습니다. 그 목록은 레포 안의 텍스트 파일 하나입니다:

```
cli/src/pcluster/resources/supported-regions
```

여기에 리전을 추가하고 빌드하면 됩니다. 다른 리전에서 베이스 AMI를 복사해오면 실제로 동작합니다. `eu-south-2`(스페인)가 ParallelCluster 공식 GA 리전이 되기 전에 이미 p6-b200 클러스터를 거기서 돌린 사례가 있습니다. 꼼수가 아니라 소프트웨어 구조의 자연스러운 결과입니다.

```bash
git clone https://github.com/aws/aws-parallelcluster.git
cd aws-parallelcluster && git checkout v3.15.0

vi cli/src/pcluster/resources/supported-regions   # 리전 추가

cd cli && pip install packaging wheel
pip install -r requirements.txt
python setup.py bdist_wheel
pip install ./dist/aws_parallelcluster-3.15.0-py3-none-any.whl
```

---

## 클러스터가 뜨기도 전에 롤백되나요?

그렇습니다. p6-b200 같은 GPU 인스턴스에서는 이 문제를 모르면 계속 당합니다.

`pcluster create-cluster`를 실행하면 CloudFormation이 스택을 시작하고 모든 리소스가 성공 신호를 보내기를 기다립니다. 컴퓨트 노드는 cloud-init을 돌리고, cinc(Chef 부트스트랩)를 실행하고, 드라이버를 설치하고, `ComputeNodeBootstrapTimeout` 안에 `cfn-signal`을 보내야 합니다. p6-b200에서 이 부트스트랩만 15~25분이 걸립니다. 기본 타임아웃은 30분입니다. 제때 신호를 못 보내면 CloudFormation이 실패로 표시하고 스택 전체를 롤백합니다.

롤백이 되면 HeadNode, FSx 연결, 네트워킹 — 전부 사라집니다. 처음부터 다시 만들어야 합니다.

두 가지 설정이 이 상황을 크게 바꿔줍니다:

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

타임아웃 증가는 단순 계산입니다 — 부트스트랩이 끝날 시간을 충분히 주는 것입니다. `--rollback-on-failure false`가 더 중요합니다. 노드가 실패해도 스택을 살려두기 때문에, SSM으로 접속해서 무슨 일이 있었는지 실제로 볼 수 있습니다. 이 옵션 없이는 실패할 때마다 클러스터가 날아가고 눈 가리고 디버깅해야 합니다.

> ##### DANGER
>
> Capacity Block 인스턴스에서 롤백은 특히 치명적입니다. 스택이 해체되면 CB 슬롯이 반환되고 다시 확보하지 못할 수 있습니다. p6-b200 설정을 반복 테스트할 때는 반드시 `--rollback-on-failure false`를 사용하세요.
{: .block-danger }

덧붙이면 — 노드가 실패했을 때 클러스터를 삭제하고 재생성하지 마세요. `pcluster update-cluster`로 설정을 밀거나, SSM으로 문제 노드에 직접 접속해서 고치세요. 재생성하면 HeadNode 부트스트랩도 다시 거쳐야 합니다. 10~15분이 또 날아갑니다.

---

## 결국 어떤 서비스냐

ParallelCluster는 어정쩡한 위치에 있습니다. 매니지드 서비스가 아닙니다 — AWS가 여러분을 대신해 운영하는 건 없습니다. 그렇다고 얇은 래퍼도 아닙니다 — cinc, clustermgtd, cfn-hup, SPANK 플러그인 스택 같이 클러스터 안에서 조용히 동작하며 여러분이 명시적으로 요청하지 않은 일들을 하는 상당한 오케스트레이션 레이어가 있습니다.

그 중간 어딘가를 이해하는 것이 이 시리즈의 목적입니다. 다음 글에서는 `pcluster create-cluster`부터 `slurmd`가 실행되기까지 실제로 무슨 일이 일어나는지 다룹니다. GPU 인스턴스에서 만나는 거의 모든 실패 원인이 거기서 시작합니다.

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> ← 현재 위치: **Part 1: ParallelCluster는 어떤 서비스인가**
> [Part 2: ParallelCluster 내부 동작 원리 →](/pages/pcluster-series-1-internals-ko/)
{: .block-tip }

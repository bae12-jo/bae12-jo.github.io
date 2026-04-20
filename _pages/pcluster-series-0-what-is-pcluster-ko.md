---
title: "Part 1: AWS가 만들었지만 당신이 실행한다"
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

ParallelCluster는 Python CLI입니다. 직접 설치하고, 실행하면, 여러분의 AWS 계정에 CloudFormation 스택, EC2 인스턴스, VPC, 그 밖에 설정 파일에 정의한 인프라를 직접 만들어냅니다. 요청을 받는 "ParallelCluster 서비스"가 없습니다. 로직은 명령어를 입력한 곳에서 돌아갑니다.

```bash
pip install aws-parallelcluster==3.15.0
pcluster create-cluster --cluster-configuration config.yaml
```

이 명령어를 실행하기 전에 기반 인프라가 먼저 존재해야 합니다. VPC, 서브넷, 라우팅, 보안 그룹, FSx Lustre, IAM 역할, VPC 엔드포인트, 이 중 어느 것도 pcluster가 직접 만들어주지 않습니다. 이 설정에서는 별도의 CloudFormation 스택으로 먼저 배포하고, pcluster 설정 파일이 그 스택의 출력값(서브넷 ID, FSx 파일시스템 ID, 보안 그룹 ID)을 참조하는 방식을 씁니다.

---

## 실제로 어떤 의미냐면

EKS나 SageMaker는 AWS가 컨트롤 플레인을 소유하고 운영합니다. 사용자는 AWS API를 호출하고, 업그레이드 시점도 AWS가 결정합니다.

ParallelCluster는 컨트롤 플레인이 없습니다. CLI 자체가 제품입니다. 그래서 대부분의 AWS 서비스에서는 불가능한 것이 가능합니다. 버전을 정확히 고정하고, 직접 결정하기 전까지 그 상태를 유지할 수 있습니다. 반대로 업그레이드 프로세스는 사용자 몫입니다. 보안 패치와 새 기능이 자동으로 오지 않습니다.

새 인스턴스 타입 지원은 추가되긴 합니다. 다만 항상 즉시는 아닙니다. 새 GPU 인스턴스가 출시되면 공식 릴리즈가 따라오는 데 시간이 걸리는 경우가 있습니다. 하지만 소스가 공개돼 있고 CLI가 CloudFormation과 EC2에 직접 말을 걸기 때문에, 커스텀 AMI를 쓰면 공식 지원 전에도 미지원 인스턴스를 구동할 수 있습니다. 이 시리즈의 나머지가 p6-b200으로 그 방법을 정확히 보여줍니다.

소스 코드는 전부 공개되어 있습니다: [github.com/aws/aws-parallelcluster](https://github.com/aws/aws-parallelcluster). GPU 노드를 설정하는 Chef 쿡북, 노드 스케일링을 관리하는 데몬, 부트스트랩 스크립트, 전부 읽을 수 있습니다. 무언가 깨지면 코드를 봅니다. 어떤 문서보다 유용했습니다.

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

단, AWS가 공식 지원 리전 목록을 관리하는 데는 이유가 있습니다. 목록 밖에서 배포하고 문제가 생기면 AWS 지원을 받을 수 없습니다. 전적으로 혼자 해결해야 합니다. 프로덕션 워크로드라면 공식 목록 안에서 사용하세요. 실험이나 새 리전 선점이 목적이라면 지원 경계를 이해한 상태에서 써도 괜찮습니다.

---

## 결국 어떤 서비스냐

ParallelCluster는 어정쩡한 위치에 있습니다. 매니지드 서비스가 아닙니다. AWS가 여러분을 대신해 운영하는 건 없습니다. 그렇다고 얇은 래퍼도 아닙니다. cinc, clustermgtd, cfn-hup, SPANK 플러그인 스택 같이 클러스터 안에서 조용히 동작하며 여러분이 명시적으로 요청하지 않은 일들을 하는 상당한 오케스트레이션 레이어가 있습니다.

그 중간 어딘가를 이해하는 것이 이 시리즈의 목적입니다. 다음 글에서는 `pcluster create-cluster`부터 `slurmd`가 실행되기까지 실제로 무슨 일이 일어나는지 다룹니다. GPU 인스턴스에서 만나는 거의 모든 실패 원인이 거기서 시작합니다.

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> 현재 위치: **Part 1: ParallelCluster는 어떤 서비스인가**
> [Part 2: ParallelCluster 내부 동작 원리 →](/pages/pcluster-series-1-internals-ko/)
{: .block-tip }

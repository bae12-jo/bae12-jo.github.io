---
title: "Part 5: NCCL 테스트"
author: Bailey Sohyeon Cho
layout: post
lang: ko
lang_peer: /pages/pcluster-series-4-nccl-en/
---

# p6-b200 NCCL 테스트: EFA v3로 B200 크로스 노드 대역폭 측정

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 4: 커스텀 AMI 만들기](/pages/pcluster-series-3-custom-ami-ko/)

클러스터가 안정화되면 가장 먼저 측정할 것은 노드 간 통신 대역폭입니다. NCCL 테스트는 실제 학습 잡을 돌리기 전에, 네트워크 패브릭이 실제로 얼마를 내주는지 정확하게 보여줍니다.

이 글에서는 p6-b200.48xlarge 두 노드(B200 GPU 16개)에 EFA v3를 사용해서 측정한 설정과 결과를 다룹니다.

---

## 생각보다 까다로운 이유

`nccl-tests`는 간단해 보입니다. 레포 클론, 빌드, 실행. GPU 클러스터에 EFA가 붙으면 조용히 실패하는 포인트가 여러 개 있습니다.

- OpenMPI가 Slurm PMI 없이 빌드된 경우 `srun`으로 MPI 바이너리를 실행하면 `MPI_Init`이 실패합니다. pcluster AMI의 `/opt/amazon/openmpi`가 정확히 이 경우입니다.
- p6-b200의 TCP bootstrap 인터페이스(`enp71s0`)는 EFA 데이터 인터페이스(`rdmap*`)와 다릅니다. `NCCL_SOCKET_IFNAME`을 EFA 인터페이스로 설정하면 bootstrap이 실패합니다.
- `mpirun`의 크로스 노드 SSH는 ubuntu 유저 키가 필요합니다. root SSH는 pcluster가 차단합니다.
- NCCL 라이브러리가 pcluster AMI에 없습니다. nccl-tests 빌드 전에 `libnccl-dev`를 따로 설치해야 합니다.

---

## 환경

**하드웨어:**
- 2x p6-b200.48xlarge
- 노드당 NVIDIA B200 8개 (총 16개)
- NVLink5 노드 내부 패브릭

**네트워크:**
- EFA v3: 노드당 32개 EFA 어댑터, 각 100 Gbps = 3.2 Tbps = 400 GB/s
- TCP bootstrap 인터페이스: `enp71s0`
- EFA 데이터 인터페이스: `rdmap79s0`, `rdmap80s0` 등 (rdmap 계열 16개)

**소프트웨어:**
- NCCL 2.29.7+cuda13.2
- nccl-tests 2.18.3
- `/opt/amazon/openmpi`

---

## nccl-tests 빌드

pcluster AMI에 NCCL dev 라이브러리가 없습니다. 먼저 설치합니다:

```bash
curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb \
  -o /tmp/cuda-keyring.deb
dpkg -i /tmp/cuda-keyring.deb && apt-get update -qq
apt-get install -y libnccl2 libnccl-dev
```

컴퓨트 노드에서 MPI 포함 빌드합니다. HeadNode는 GPU가 없어서 빌드가 안 됩니다. FSx에 저장해 두면 모든 노드가 같은 바이너리를 씁니다:

```bash
mkdir -p /fsx/nccl-tests/bin
cd /tmp && git clone --depth=1 https://github.com/NVIDIA/nccl-tests.git
cd nccl-tests
make MPI=1 \
     MPI_HOME=/opt/amazon/openmpi \
     CUDA_HOME=/usr/local/cuda \
     NCCL_HOME=/usr \
     -j$(nproc)
cp build/*_perf /fsx/nccl-tests/bin/
```

한 번 빌드하면 FSx를 통해 모든 노드에서 사용 가능합니다. 노드 시작마다 재빌드할 필요 없습니다.

---

## 환경 설정

모든 노드가 실행 전에 source할 env 파일을 만듭니다:

```bash
# /fsx/nccl-env.sh
export LD_LIBRARY_PATH=/opt/amazon/openmpi/lib:/opt/amazon/efa/lib:/usr/local/cuda/lib64:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}
export PATH=/opt/amazon/openmpi/bin:/opt/amazon/efa/bin:/usr/local/cuda/bin:/opt/slurm/bin:${PATH}

# EFA
export FI_PROVIDER=efa
export FI_EFA_USE_DEVICE_RDMA=1

# NCCL
export NCCL_SOCKET_IFNAME=enp71s0   # TCP bootstrap — EFA rdmap 인터페이스 아님
export NCCL_IB_DISABLE=0            # EFA 데이터 전송 허용
export NCCL_NET_GDR_LEVEL=5
export NCCL_CROSS_NIC=1
export NCCL_DEBUG=WARN
```

`NCCL_SOCKET_IFNAME=enp71s0`이 핵심입니다. NCCL은 이 인터페이스로 bootstrap rendezvous(프로세스 탐색)를 합니다. EFA `rdmap*` 인터페이스는 실제 데이터 트래픽을 담당합니다. EFA 인터페이스를 bootstrap에 사용하면 `Bootstrap: no socket interface found`가 발생하고 데이터가 전혀 이동하기 전에 실패합니다.

---

## mpirun으로 크로스 노드 실행

pcluster 노드의 `/opt/amazon/openmpi`는 Slurm PMI 없이 빌드됐습니다. MPI 링크된 바이너리를 `srun`으로 실행하면 `MPI_Init`이 PMI 지원 관련 에러로 실패합니다.

`mpirun`에 hostfile을 사용하세요. ubuntu 유저로 실행합니다. 크로스 노드 SSH는 ubuntu에 설정되어 있고, root는 차단되어 있습니다.

```bash
# hostfile 생성 (노드당 1줄, 8 슬롯)
scontrol show hostnames $SLURM_JOB_NODELIST | while read h; do
  echo "$h slots=8"
done > /fsx/nccl-hostfile

# ubuntu 유저로 실행
su - ubuntu -c "
  source /fsx/nccl-env.sh
  /opt/amazon/openmpi/bin/mpirun \
    --hostfile /fsx/nccl-hostfile \
    -np 16 --map-by ppr:8:node \
    -x PATH -x LD_LIBRARY_PATH \
    -x FI_PROVIDER -x FI_EFA_USE_DEVICE_RDMA \
    -x NCCL_SOCKET_IFNAME -x NCCL_IB_DISABLE \
    -x NCCL_NET_GDR_LEVEL -x NCCL_CROSS_NIC -x NCCL_DEBUG \
    --mca pml ob1 --mca btl ^openib \
    --mca btl_tcp_if_exclude lo,docker0 \
    --bind-to none \
    /fsx/nccl-tests/bin/all_reduce_perf \
      --minbytes 1K --maxbytes 8G \
      --stepfactor 2 --iters 100 --warmup_iters 5 \
      --check 0 --op sum 2>&1
"
```

---

## 결과

### AllReduce (2노드 16× B200, EFA v3)

| 크기 | AlgBW (GB/s) | BusBW (GB/s) | Latency (μs) |
|------|-------------|-------------|-------------|
| 1 KB | 0.02 | 0.04 | 52.8 |
| 1 MB | 9.79 | 18.36 | 107.1 |
| 64 MB | 129.96 | 243.68 | 516.4 |
| 256 MB | 232.00 | 435.00 | 1,157 |
| 1 GB | 304.10 | 570.19 | 3,531 |
| 4 GB | 349.15 | 654.67 | 12,301 |
| **8 GB** | **364.75** | **683.90** | **23,550** |

Peak BusBW: **683.90 GB/s**

### AllToAll (2노드 16× B200, EFA v3)

| 크기 | AlgBW (GB/s) | BusBW (GB/s) | Latency (μs) |
|------|-------------|-------------|-------------|
| 1 MB | 6.11 | 5.73 | 171.6 |
| 64 MB | 59.89 | 56.15 | 1,120 |
| 256 MB | 86.25 | 80.86 | 3,112 |
| 1 GB | 92.80 | 87.00 | 11,571 |
| **8 GB** | **95.09** | **89.14** | **90,339** |

Peak BusBW: **89.14 GB/s**

---

## 수치 해석

**AllReduce busbw**는 링 알고리즘 공식을 따릅니다: `busbw = algbw × 2×(N-1)/N`. N=16 rank에서 `algbw × 1.875`입니다. Peak algbw 364.75 GB/s × 1.875 = 683.9 GB/s로 공식과 일치합니다.

**EFA 효율**: 각 노드의 총 EFA 대역폭은 400 GB/s입니다. Peak algbw 364.75 GB/s는 이론치의 91%입니다. 대부분의 배포가 60~85% 구간에 있는 것에 비해 높은 결과입니다.

**AllToAll**이 낮은 이유는 당연합니다. 16개 rank 각각이 나머지 15개에 데이터를 보내야 하는데, 그 중 8개만 EFA를 거칩니다. 이 토폴로지에서 이론 상한은 약 93 GB/s algbw이고, 95.09 GB/s는 사실상 라인 레이트입니다.

**단일 노드 참고값**: 8 GPU 단일 노드에서 NVLink5만 사용한 all_reduce는 busbw 572 GB/s가 피크입니다. 크로스 노드 링이 683.90 GB/s로 더 높은 이유는, 16개 GPU가 더 넓은 링을 구성해 동시에 더 많은 대역폭을 활용하기 때문입니다.

---

## B200 이론 피크 참고

| Precision | TFLOPS/GPU | 16 GPU 합산 |
|-----------|-----------|------------|
| FP8 | 18,000 | 288,000 |
| BF16 | 9,000 | 144,000 |
| FP32 | 1,800 | 28,800 |

통신 효율이 학습 처리량의 상한을 결정합니다. 683 GB/s all_reduce 대역폭에서, 두 노드 간 8GB all-reduce는 약 24ms가 걸립니다. BF16로 70B 파라미터 모델이라면 그라디언트가 약 140GB이고 최대 속도에서 약 5초짜리 all-reduce입니다. 실제로는 컴퓨트와 통신을 겹쳐서 실행하는 것이 이를 감당 가능하게 만듭니다.

---

> **시리즈**: 분산 학습을 위한 GPU Cluster 세팅하기
>
> [← Part 4: 커스텀 AMI 만들기](/pages/pcluster-series-3-custom-ami-ko/) | 현재: **Part 5: p6-b200 NCCL 테스트**
{: .block-tip }

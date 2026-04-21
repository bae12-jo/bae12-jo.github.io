---
title: "Part 5: NCCL Tests"
author: Bailey Sohyeon Cho
layout: post
lang: en
lang_peer: /pages/pcluster-series-4-nccl-ko/
---

# Running NCCL Tests on p6-b200: Cross-Node Bandwidth on B200 with EFA v3

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 4: Building a Custom AMI](/pages/pcluster-series-3-custom-ami/)

Once the cluster is stable, the first thing worth measuring is inter-node communication bandwidth. NCCL tests give you a precise picture of what your network fabric is actually delivering — before you run any real training job.

This post covers the setup we used on two p6-b200.48xlarge nodes (16 B200 GPUs total, connected via EFA v3) and the results.

---

## Why this is harder than it looks

`nccl-tests` seems simple to run. Clone the repo, build, execute. On a GPU cluster with EFA, there are several places it can go wrong silently:

- MPI doesn't interoperate with Slurm's `srun` unless OpenMPI was built with PMI support. The `/opt/amazon/openmpi` on pcluster AMIs is not built with Slurm PMI. Using `srun` with MPI-linked binaries causes `MPI_Init` to fail.
- The bootstrap network interface (`enp71s0` on p6-b200) is different from the EFA data interfaces (`rdmap*`). Setting `NCCL_SOCKET_IFNAME` to an EFA interface breaks bootstrapping.
- Cross-node SSH for `mpirun` requires the ubuntu user's key — not root. root SSH is blocked by pcluster.
- NCCL libraries aren't included in the pcluster AMI. `libnccl-dev` must be installed separately before building nccl-tests.

---

## What we're working with

**Hardware:**
- 2x p6-b200.48xlarge
- 8x NVIDIA B200 per node (16 total)
- NVLink5 intra-node fabric

**Network:**
- EFA v3: 32 EFA adapters per node, 100 Gbps each = 3.2 Tbps = 400 GB/s total per node
- TCP bootstrap interface: `enp71s0`
- EFA data interfaces: `rdmap79s0`, `rdmap80s0`, `rdmap96s0`, `rdmap97s0`, `rdmap113s0`, `rdmap114s0`, `rdmap132s0`, `rdmap133s0` (and more)

**Software:**
- NCCL 2.29.7+cuda13.2
- nccl-tests 2.18.3
- OpenMPI from `/opt/amazon/openmpi`

---

## Building nccl-tests

NCCL dev libraries aren't on the pcluster AMI. Install them first:

```bash
# Add CUDA repo
curl -fsSL https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb \
  -o /tmp/cuda-keyring.deb
dpkg -i /tmp/cuda-keyring.deb && apt-get update -qq
apt-get install -y libnccl2 libnccl-dev
```

Build nccl-tests with MPI. Build it on a compute node (the HeadNode has no GPUs and no CUDA), save to shared FSx so every node can use the same binary:

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

Build once, use from every node via FSx. No need to rebuild on each node launch.

---

## Environment setup

Create an env file that all nodes source before running:

```bash
# /fsx/nccl-env.sh
export LD_LIBRARY_PATH=/opt/amazon/openmpi/lib:/opt/amazon/efa/lib:/usr/local/cuda/lib64:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}
export PATH=/opt/amazon/openmpi/bin:/opt/amazon/efa/bin:/usr/local/cuda/bin:/opt/slurm/bin:${PATH}

# EFA
export FI_PROVIDER=efa
export FI_EFA_USE_DEVICE_RDMA=1

# NCCL
export NCCL_SOCKET_IFNAME=enp71s0   # TCP bootstrap — NOT the EFA rdmap interfaces
export NCCL_IB_DISABLE=0            # allow EFA for data transport
export NCCL_NET_GDR_LEVEL=5
export NCCL_CROSS_NIC=1
export NCCL_DEBUG=WARN
```

The `NCCL_SOCKET_IFNAME=enp71s0` line is important. NCCL uses this interface for its bootstrap rendezvous (process discovery). The EFA `rdmap*` interfaces handle the actual data traffic. Using an EFA interface for bootstrap causes `Bootstrap: no socket interface found` and the test fails before data ever moves.

---

## Running cross-node with mpirun

The `/opt/amazon/openmpi` installation on pcluster nodes is not built with Slurm PMI. This means you cannot use `srun` to launch MPI-linked binaries — `MPI_Init` will fail with a message about PMI support.

Use `mpirun` with a hostfile instead. Run it as the `ubuntu` user: cross-node SSH is configured for ubuntu, not root.

```bash
# Generate hostfile (one line per node, 8 slots each)
scontrol show hostnames $SLURM_JOB_NODELIST | while read h; do
  echo "$h slots=8"
done > /fsx/nccl-hostfile

# Run as ubuntu — root SSH is blocked
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

## Results

### AllReduce (2 nodes, 16x B200, EFA v3)

| Size | AlgBW (GB/s) | BusBW (GB/s) | Latency (μs) |
|------|-------------|-------------|-------------|
| 1 KB | 0.02 | 0.04 | 52.8 |
| 1 MB | 9.79 | 18.36 | 107.1 |
| 64 MB | 129.96 | 243.68 | 516.4 |
| 256 MB | 232.00 | 435.00 | 1,157 |
| 1 GB | 304.10 | 570.19 | 3,531 |
| 4 GB | 349.15 | 654.67 | 12,301 |
| **8 GB** | **364.75** | **683.90** | **23,550** |

Peak BusBW: **683.90 GB/s**

### AllToAll (2 nodes, 16x B200, EFA v3)

| Size | AlgBW (GB/s) | BusBW (GB/s) | Latency (μs) |
|------|-------------|-------------|-------------|
| 1 MB | 6.11 | 5.73 | 171.6 |
| 64 MB | 59.89 | 56.15 | 1,120 |
| 256 MB | 86.25 | 80.86 | 3,112 |
| 1 GB | 92.80 | 87.00 | 11,571 |
| **8 GB** | **95.09** | **89.14** | **90,339** |

Peak BusBW: **89.14 GB/s**

---

## How to read these numbers

**AllReduce busbw** follows the ring algorithm formula: `busbw = algbw × 2×(N-1)/N`. With N=16 ranks, that's `algbw × 1.875`. Our peak algbw of 364.75 GB/s × 1.875 = 683.9 GB/s. The formula checks out — the measurement is internally consistent.

**EFA efficiency**: Each node has 400 GB/s total EFA bandwidth. Peak algbw of 364.75 GB/s is 91% of that theoretical maximum. That's a strong result — most deployments sit in the 60-85% range due to protocol overhead and routing.

**AllToAll** is expected to be lower. Each of the 16 ranks needs to send data to 15 others, and only 8 of those 15 are on the other node (going through EFA). The theoretical ceiling for our topology is around 93 GB/s algbw. We hit 95.09 GB/s, which is essentially at line rate.

**Intra-node reference**: Running all_reduce with 8 GPUs on a single node (using NVLink5 only) peaks at 572 GB/s busbw. The cross-node ring peaks higher at 683.90 GB/s because 16 GPUs form a wider ring with more total bandwidth in flight simultaneously.

---

## B200 theoretical peaks for context

| Precision | TFLOPS/GPU | 16 GPU total |
|-----------|-----------|-------------|
| FP8 | 18,000 | 288,000 |
| BF16 | 9,000 | 144,000 |
| FP32 | 1,800 | 28,800 |

Communication efficiency directly bounds training throughput. At 683 GB/s all_reduce bandwidth, gradient synchronization between these two nodes takes about 24ms for an 8GB all-reduce. For a 70B parameter model in BF16, that's roughly 140GB of gradients — about a 5-second all-reduce at peak. Overlap with compute is what makes this tolerable in practice.

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> [← Part 4: Building a Custom AMI](/pages/pcluster-series-3-custom-ami/) | You are here: **Part 5: NCCL Tests on p6-b200**
{: .block-tip }

---
title: "Part 1: Built by AWS, Run by You"
author: Bailey Sohyeon Cho
layout: post
lang: en
lang_peer: /pages/pcluster-series-0-what-is-pcluster-ko/
---

# Built by AWS, Run by You: What Kind of Service Is ParallelCluster?

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> **Part 1 of 4** — [Part 2: How ParallelCluster Works Under the Hood →](/pages/pcluster-series-1-internals/)

Most engineers assume ParallelCluster is a managed service, something like EKS or SageMaker, where AWS runs a control plane and you talk to it through an API. It isn't.

ParallelCluster is a Python CLI. You install it, run it, and it reaches directly into your AWS account to create CloudFormation stacks, EC2 instances, VPCs, and any other infrastructure defined in your config. There's no ParallelCluster service receiving your request. The logic runs wherever you type the command.

```bash
pip install aws-parallelcluster==3.15.0
pcluster create-cluster --cluster-configuration config.yaml
```

Before you run this, the underlying infrastructure needs to exist. VPC, subnets, routing, security groups, FSx Lustre, IAM roles, and VPC endpoints are all prerequisites. None of these are created by pcluster itself. In this setup we deploy them as a separate CloudFormation stack first, then point the pcluster config at the outputs (subnet IDs, FSx filesystem ID, security group IDs). See [this repo](https://github.com/bae12-jo/parallelcluster-for-llm-training) for reference configurations.

---

## What this means in practice

With EKS or SageMaker, AWS owns and operates the control plane. You hit their API and they decide when to upgrade it.

With ParallelCluster, there is no control plane. The CLI is the product. This gives you something most AWS services don't: the ability to pin an exact version and have it stay there until you decide otherwise. It also means you own the upgrade process. Security patches and new features don't arrive automatically.

New instance type support does get added to ParallelCluster, just not always immediately. When a new GPU instance ships, there's often a lag before the official release catches up. But here's the thing — because the source is open and the CLI just talks to CloudFormation and EC2, you can run unsupported instance types with a custom AMI before they're officially blessed. The rest of this series shows exactly how we did that with p6-b200.

The source code is completely open: [github.com/aws/aws-parallelcluster](https://github.com/aws/aws-parallelcluster). The Chef cookbooks that configure your GPU nodes, the daemon that manages node scaling, the bootstrap scripts, all of it is readable. When something breaks, you look at the code. In practice, this has been more useful than any amount of documentation.

---

## It runs in regions AWS hasn't officially shipped it to

Because the CLI just calls CloudFormation and EC2, it isn't technically gated to AWS's official supported region list. That list is a text file in the repo:

```
cli/src/pcluster/resources/supported-regions
```

Add a region there, build the wheel, install it, and it works. With a base AMI copied from another region, someone ran a p6-b200 cluster in `eu-south-2` (Spain) before it was an officially supported region for ParallelCluster. Not a hack, just a consequence of how the software is structured.

```bash
git clone https://github.com/aws/aws-parallelcluster.git
cd aws-parallelcluster && git checkout v3.15.0

vi cli/src/pcluster/resources/supported-regions   # add your region

cd cli && pip install packaging wheel
pip install -r requirements.txt
python setup.py bdist_wheel
pip install ./dist/aws_parallelcluster-3.15.0-py3-none-any.whl
```

That said, AWS does maintain an official supported region list for a reason. If you deploy outside it and run into issues, AWS support won't cover you. You're on your own. For production workloads, stick to the official list. For experimentation or early access to new regions, it's a viable option as long as you understand the support boundary.

---

## The bigger picture

ParallelCluster sits in an unusual spot. It's not a managed service, AWS doesn't run anything on your behalf. But it's also not a thin wrapper. There's a substantial amount of orchestration logic (cinc, clustermgtd, cfn-hup, the SPANK plugin stack) that runs inside your cluster and does things you didn't explicitly ask for.

Understanding that middle ground is what the rest of this series is about. The next post goes through what actually happens from `pcluster create-cluster` to a running `slurmd`, because that sequence explains nearly every failure mode you'll hit on GPU instances.

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> You are here: **Part 1: What Kind of Service Is ParallelCluster?**
> [Part 2: How ParallelCluster Works Under the Hood →](/pages/pcluster-series-1-internals/)
{: .block-tip }

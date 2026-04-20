---
title: "Distributed Training - Part 1: Built by AWS, Run by You"
author: Bailey Sohyeon Cho
layout: post
lang: en
lang_peer: /pages/pcluster-series-0-what-is-pcluster-ko/
---

# Built by AWS, Run by You: What Kind of Service Is ParallelCluster?

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> **Part 1 of 4** — [Part 2: How ParallelCluster Works Under the Hood →](/pages/pcluster-series-1-internals/)

Most engineers assume ParallelCluster is a managed service — something like EKS or SageMaker, where AWS runs a control plane and you talk to it through an API. It isn't.

ParallelCluster is a Python CLI. You install it, run it, and it reaches directly into your AWS account to create CloudFormation stacks, EC2 instances, FSx filesystems, and VPCs. There's no ParallelCluster service receiving your request. The logic runs wherever you type the command.

```bash
pip install aws-parallelcluster==3.15.0
pcluster create-cluster --cluster-configuration config.yaml
```

That's the whole thing.

---

## What this means in practice

With EKS or SageMaker, AWS owns and operates the control plane. You hit their API. They decide when to upgrade it.

With ParallelCluster, there is no control plane. The CLI is the product. This gives you something most AWS services don't: the ability to pin an exact version and have it stay there until you decide otherwise. It also means AWS doesn't push upgrades at you — but it equally means security patches and new instance type support don't arrive automatically either. That trade-off is worth knowing going in.

The source code is completely open: [github.com/aws/aws-parallelcluster](https://github.com/aws/aws-parallelcluster). The Chef cookbooks that configure your GPU nodes, the daemon that manages node scaling, the bootstrap scripts — all of it is readable. When something breaks, you look at the code. In practice, this has been more useful than any amount of documentation.

---

## It runs in regions AWS hasn't officially shipped it to

Because the CLI just calls CloudFormation and EC2, it's not technically gated to AWS's official supported region list. That list is a text file in the repo:

```
cli/src/pcluster/resources/supported-regions
```

Add a region there, build the wheel, install it, and it works. With a base AMI copied from another region, someone ran a p6-b200 cluster in `eu-south-2` (Spain) before it was an officially supported region for ParallelCluster. Not a hack — just a consequence of how the software is structured.

```bash
git clone https://github.com/aws/aws-parallelcluster.git
cd aws-parallelcluster && git checkout v3.15.0

vi cli/src/pcluster/resources/supported-regions   # add your region

cd cli && pip install packaging wheel
pip install -r requirements.txt
python setup.py bdist_wheel
pip install ./dist/aws_parallelcluster-3.15.0-py3-none-any.whl
```

---

## Will it roll back before the cluster even comes up?

Yes — and on GPU instances like p6-b200 this happens a lot until you know to watch for it.

When you run `pcluster create-cluster`, CloudFormation starts a stack and waits for every resource to signal success. Compute nodes have to complete cloud-init, run cinc (the Chef bootstrap), install drivers, and send a `cfn-signal` — all within `ComputeNodeBootstrapTimeout`. On p6-b200, that bootstrap alone takes 15–25 minutes. The default timeout is 30 minutes. If the node doesn't signal in time, CloudFormation marks it failed and rolls back the entire stack.

The rollback destroys everything: the HeadNode, the FSx association, the networking. You're back to zero and have to recreate it all from scratch.

Two settings that change this significantly:

```yaml
# cluster config
DevSettings:
  Timeouts:
    ComputeNodeBootstrapTimeout: 3600
```

```bash
# at create time
pcluster create-cluster \
  --cluster-configuration config.yaml \
  --rollback-on-failure false
```

The timeout increase is just math — give the bootstrap enough room. The `--rollback-on-failure false` flag is more important: it keeps the stack alive when a node fails, so you can SSH or SSM in and actually look at what went wrong. Without it, every failed attempt wipes the cluster and you're debugging blind.

> ##### DANGER
>
> On Capacity Block instances, a rollback is especially costly. The CB slot gets released when the stack tears down, and you may not get it back. If you're iterating on a p6-b200 setup, always use `--rollback-on-failure false`.
{: .block-danger }

One more thing: if a node fails during iteration, don't delete the cluster and recreate it. Use `pcluster update-cluster` to push config changes, or fix things directly on the stuck node via SSM. Recreating means bootstrapping the HeadNode again — another 10–15 minutes gone.

---

## The bigger picture

ParallelCluster sits in an unusual spot. It's not a managed service — AWS doesn't run anything on your behalf. But it's also not a thin wrapper — there's a substantial amount of orchestration logic (cinc, clustermgtd, cfn-hup, the SPANK plugin stack) that runs inside your cluster and does things you didn't explicitly ask for.

Understanding that middle ground is what the rest of this series is about. The next post goes through what actually happens from `pcluster create-cluster` to a running `slurmd` — because that sequence explains nearly every failure mode you'll hit on GPU instances.

---

> **Series**: Setting Up a GPU Cluster for Distributed Training
>
> ← You are here: **Part 1: What Kind of Service Is ParallelCluster?**
> [Part 2: How ParallelCluster Works Under the Hood →](/pages/pcluster-series-1-internals/)
{: .block-tip }

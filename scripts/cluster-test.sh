#!/bin/bash
# Throwaway 3-node Bosun cluster on one Docker host, for testing leader election,
# failover and quorum loss. Nodes n1..n3 on a private network; UI on 127.0.0.1:3151-3153.
# Usage: scripts/cluster-test.sh up|down|status|stop N|start N|recreate N [docker run args]
# Env: BOSUN_IMAGE (default bosun:latest), BOSUN_ENV_FILE (MASTER_KEY/AUTH_SECRET, default ./.env)
NET=bosun-cluster-test
IMG=${BOSUN_IMAGE:-bosun:latest}
JOIN=bosun-n1:4002,bosun-n2:4002,bosun-n3:4002
ENVF=${BOSUN_ENV_FILE:-./.env}

start_node() {
  local i=$1; shift
  docker run -d --name bosun-n$i --hostname bosun-n$i --network $NET --env-file $ENVF \
    -e NODE_NAME=n$i -e RQLITE_ADV_HOST=bosun-n$i -e RQLITE_JOIN=$JOIN -e RQLITE_BOOTSTRAP_EXPECT=3 -e COOKIE_SECURE=false "$@" \
    -p 127.0.0.1:315$i:3042 -v bosun-n$i-data:/data/rqlite --memory 768m --cpus 1 $IMG >/dev/null && echo "started n$i"
}

case "$1" in
  up)
    docker network create $NET >/dev/null 2>&1
    for i in 1 2 3; do start_node $i; done ;;
  down)
    for i in 1 2 3; do docker rm -f bosun-n$i >/dev/null 2>&1; docker volume rm bosun-n$i-data >/dev/null 2>&1; done
    docker network rm $NET >/dev/null 2>&1; echo down ;;
  stop) docker stop -t 10 bosun-n$2 >/dev/null && echo "stopped n$2" ;;
  start) docker start bosun-n$2 >/dev/null && echo "restarted n$2" ;;
  recreate) i=$2; shift 2; docker rm -f bosun-n$i >/dev/null; start_node $i "$@" ;;
  status)
    for i in 1 2 3; do
      if [ "$(docker inspect -f '{{.State.Running}}' bosun-n$i 2>/dev/null)" != "true" ]; then echo "n$i: DOWN"; continue; fi
      docker exec bosun-n$i sh -c '
        st=$(wget -qO- http://127.0.0.1:4001/status 2>/dev/null | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{try{const j=JSON.parse(s);console.log((j.store.raft.state||\"?\")+\" leader=\"+((j.store.leader||{}).node_id||\"-\"))}catch(e){console.log(\"?\")}})")
        rd=$(wget -qO- "http://127.0.0.1:4001/readyz" >/dev/null 2>&1 && echo ready || echo no-leader)
        pl=$(wget -qO- http://127.0.0.1:3003/health 2>/dev/null | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{try{const j=JSON.parse(s);console.log(\"poller \"+(j.leader?\"ACTIVE hosts=\"+j.hosts.length:\"idle\"))}catch(e){console.log(\"poller ?\")}})")
        echo "$NODE_NAME: raft=$st $rd $pl"'
    done ;;
esac
